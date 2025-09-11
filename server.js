const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Use Render's PORT or default to 8080
const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients
const clients = new Map();
const adminClients = new Set();

// Pairing system
const pairingRequests = new Map(); // clientId -> {adminId, timestamp}
const clientPairings = new Map(); // clientId -> adminId
const adminGroups = new Map(); // adminId -> Set of clientIds

// Wall configurations per admin
const wallConfigs = new Map(); // adminId -> config

// Health check endpoint for Render
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        totalClients: clients.size,
        admins: adminClients.size,
        clients: Array.from(clients.values()).filter(c => c.mode === 'client').length,
        pairings: clientPairings.size,
        uptime: process.uptime()
    });
});

// Endpoint to get server time (for clock sync)
app.get('/time', (req, res) => {
    res.json({ time: Date.now() });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    const clientId = Date.now().toString();
    console.log(`Client connected: ${clientId}`);
    
    // Store client info
    const clientInfo = {
        id: clientId,
        ws: ws,
        mode: null,
        name: null,
        deviceIndex: null,
        pairedWith: null,
        allowsPairing: true,
        lastPing: Date.now()
    };
    
    clients.set(clientId, clientInfo);
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        clientId: clientId,
        serverTime: Date.now()
    }));
    
    // Handle messages from client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleClientMessage(clientId, data);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });
    
    // Handle client disconnect
    ws.on('close', () => {
        console.log(`Client disconnected: ${clientId}`);
        const client = clients.get(clientId);
        
        if (client) {
            // Clean up admin data
            if (client.mode === 'admin') {
                adminClients.delete(clientId);
                adminGroups.delete(clientId);
                wallConfigs.delete(clientId);
                
                // Notify paired clients that admin disconnected
                const pairedClients = adminGroups.get(clientId);
                if (pairedClients) {
                    pairedClients.forEach(pairedClientId => {
                        const pairedClient = clients.get(pairedClientId);
                        if (pairedClient) {
                            pairedClient.pairedWith = null;
                            pairedClient.deviceIndex = null;
                            clientPairings.delete(pairedClientId);
                            
                            if (pairedClient.ws.readyState === WebSocket.OPEN) {
                                pairedClient.ws.send(JSON.stringify({
                                    type: 'unpaired',
                                    reason: 'Admin disconnected'
                                }));
                            }
                        }
                    });
                }
            }
            
            // Clean up client pairing
            if (client.pairedWith) {
                const adminId = client.pairedWith;
                const adminGroup = adminGroups.get(adminId);
                if (adminGroup) {
                    adminGroup.delete(clientId);
                }
                clientPairings.delete(clientId);
            }
            
            // Remove any pending pairing requests
            pairingRequests.delete(clientId);
        }
        
        clients.delete(clientId);
        broadcastClientList();
    });
    
    // Handle errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
    });
    
    // Send initial client list
    broadcastClientList();
});

// Handle messages from clients
function handleClientMessage(clientId, data) {
    const client = clients.get(clientId);
    if (!client) return;
    
    switch (data.type) {
        case 'register':
            client.mode = data.mode;
            client.name = data.name || `${data.mode}-${clientId.slice(-4)}`;
            
            if (data.mode === 'admin') {
                adminClients.add(clientId);
                adminGroups.set(clientId, new Set());
                wallConfigs.set(clientId, {
                    rows: 2,
                    cols: 2,
                    mode: 'painting', // 'painting' or 'unified'
                    mediaUrl: '',
                    source: 'direct'
                });
            }
            
            console.log(`Client ${clientId} registered as ${data.mode} (${client.name})`);
            broadcastClientList();
            break;
            
        case 'listClients':
            // Send list of available clients to admin
            if (client.mode === 'admin') {
                const clientList = Array.from(clients.values())
                    .filter(c => c.mode === 'client')
                    .map(c => ({
                        id: c.id,
                        name: c.name,
                        paired: c.pairedWith !== null,
                        pairedWith: c.pairedWith,
                        deviceIndex: c.deviceIndex,
                        allowsPairing: c.allowsPairing
                    }));
                
                client.ws.send(JSON.stringify({
                    type: 'clientList',
                    clients: clientList,
                    pairedClients: Array.from(adminGroups.get(clientId) || [])
                }));
            }
            break;
            
        case 'requestPairing':
            // Admin requests to pair with a client
            if (client.mode === 'admin' && data.clientId) {
                const targetClient = clients.get(data.clientId);
                if (targetClient && targetClient.mode === 'client' && targetClient.allowsPairing) {
                    // Store pairing request
                    pairingRequests.set(data.clientId, {
                        adminId: clientId,
                        adminName: client.name,
                        timestamp: Date.now()
                    });
                    
                    // Send pairing request to client
                    targetClient.ws.send(JSON.stringify({
                        type: 'pairingRequest',
                        adminId: clientId,
                        adminName: client.name
                    }));
                    
                    console.log(`Pairing request from admin ${clientId} to client ${data.clientId}`);
                }
            }
            break;
            
        case 'pairingResponse':
            // Client responds to pairing request
            if (client.mode === 'client' && pairingRequests.has(clientId)) {
                const request = pairingRequests.get(clientId);
                const admin = clients.get(request.adminId);
                
                if (admin && data.accept) {
                    // Accept pairing
                    client.pairedWith = request.adminId;
                    clientPairings.set(clientId, request.adminId);
                    
                    const adminGroup = adminGroups.get(request.adminId);
                    if (adminGroup) {
                        adminGroup.add(clientId);
                    }
                    
                    // Notify admin
                    admin.ws.send(JSON.stringify({
                        type: 'pairingAccepted',
                        clientId: clientId,
                        clientName: client.name
                    }));
                    
                    // Notify client
                    client.ws.send(JSON.stringify({
                        type: 'paired',
                        adminId: request.adminId,
                        adminName: request.adminName
                    }));
                    
                    console.log(`Client ${clientId} paired with admin ${request.adminId}`);
                } else {
                    // Reject pairing
                    if (admin) {
                        admin.ws.send(JSON.stringify({
                            type: 'pairingRejected',
                            clientId: clientId,
                            clientName: client.name
                        }));
                    }
                    console.log(`Client ${clientId} rejected pairing with admin ${request.adminId}`);
                }
                
                pairingRequests.delete(clientId);
                broadcastClientList();
            }
            break;
            
        case 'assignIndex':
            // Admin assigns index to paired client
            if (client.mode === 'admin' && data.clientId) {
                const targetClient = clients.get(data.clientId);
                const adminGroup = adminGroups.get(clientId);
                
                if (targetClient && adminGroup && adminGroup.has(data.clientId)) {
                    targetClient.deviceIndex = data.index;
                    
                    // Notify client of index assignment
                    targetClient.ws.send(JSON.stringify({
                        type: 'indexAssigned',
                        index: data.index
                    }));
                    
                    // Also assign to admin if it's self-assignment
                    if (data.clientId === clientId) {
                        client.deviceIndex = data.index;
                    }
                    
                    console.log(`Admin ${clientId} assigned index ${data.index} to client ${data.clientId}`);
                    broadcastClientList();
                }
            }
            break;
            
        case 'assignSelfIndex':
            // Admin assigns index to themselves
            if (client.mode === 'admin') {
                client.deviceIndex = data.index;
                console.log(`Admin ${clientId} assigned index ${data.index} to self`);
                broadcastClientList();
            }
            break;
            
        case 'updateConfig':
            // Update wall configuration for this admin
            if (client.mode === 'admin') {
                const config = wallConfigs.get(clientId);
                if (config) {
                    wallConfigs.set(clientId, { ...config, ...data.config });
                    
                    // Send updated config to all paired clients
                    const adminGroup = adminGroups.get(clientId);
                    if (adminGroup) {
                        const configMessage = JSON.stringify({
                            type: 'configUpdate',
                            config: wallConfigs.get(clientId)
                        });
                        
                        adminGroup.forEach(pairedClientId => {
                            const pairedClient = clients.get(pairedClientId);
                            if (pairedClient && pairedClient.ws.readyState === WebSocket.OPEN) {
                                pairedClient.ws.send(configMessage);
                            }
                        });
                    }
                    
                    console.log(`Admin ${clientId} updated config:`, wallConfigs.get(clientId));
                }
            }
            break;
            
        case 'sync':
            // Sync command from admin to paired clients
            if (client.mode === 'admin') {
                const config = wallConfigs.get(clientId);
                const adminGroup = adminGroups.get(clientId);
                
                if (config && adminGroup) {
                    const syncData = {
                        type: 'sync',
                        config: config,
                        syncTime: Date.now() + 2000, // Start 2 seconds from now
                        ...data
                    };
                    
                    // Send to admin itself
                    client.ws.send(JSON.stringify(syncData));
                    
                    // Send to all paired clients
                    adminGroup.forEach(pairedClientId => {
                        const pairedClient = clients.get(pairedClientId);
                        if (pairedClient && pairedClient.ws.readyState === WebSocket.OPEN) {
                            pairedClient.ws.send(JSON.stringify(syncData));
                        }
                    });
                    
                    console.log(`Sync command sent from admin ${clientId} to ${adminGroup.size} paired clients`);
                }
            }
            break;
            
        case 'unpair':
            // Unpair client from admin
            if (data.clientId) {
                const targetClient = clients.get(data.clientId);
                if (targetClient) {
                    const adminId = targetClient.pairedWith;
                    if (adminId) {
                        const adminGroup = adminGroups.get(adminId);
                        if (adminGroup) {
                            adminGroup.delete(data.clientId);
                        }
                        
                        targetClient.pairedWith = null;
                        targetClient.deviceIndex = null;
                        clientPairings.delete(data.clientId);
                        
                        // Notify client
                        targetClient.ws.send(JSON.stringify({
                            type: 'unpaired',
                            reason: 'Admin unpaired'
                        }));
                        
                        broadcastClientList();
                    }
                }
            }
            break;
            
        case 'setPairingPreference':
            // Client sets whether they allow pairing
            if (client.mode === 'client') {
                client.allowsPairing = data.allow;
                broadcastClientList();
            }
            break;
            
        case 'ping':
            // Respond to ping
            client.lastPing = Date.now();
            client.ws.send(JSON.stringify({
                type: 'pong',
                serverTime: Date.now()
            }));
            break;
            
        case 'getTime':
            // Send server time for clock sync
            client.ws.send(JSON.stringify({
                type: 'serverTime',
                time: Date.now()
            }));
            break;
            
        default:
            console.log(`Unknown message type: ${data.type}`);
    }
}

// Broadcast message to all connected clients
function broadcastToAll(message) {
    const messageStr = JSON.stringify(message);
    clients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(messageStr);
        }
    });
}

// Broadcast client list to all admins
function broadcastClientList() {
    adminClients.forEach((adminId) => {
        const admin = clients.get(adminId);
        if (admin && admin.ws.readyState === WebSocket.OPEN) {
            const clientList = Array.from(clients.values())
                .filter(c => c.mode === 'client')
                .map(c => ({
                    id: c.id,
                    name: c.name,
                    paired: c.pairedWith !== null,
                    pairedWith: c.pairedWith,
                    deviceIndex: c.deviceIndex,
                    allowsPairing: c.allowsPairing
                }));
            
            admin.ws.send(JSON.stringify({
                type: 'clientList',
                clients: clientList,
                pairedClients: Array.from(adminGroups.get(adminId) || [])
            }));
        }
    });
}

// Ping clients periodically to keep connections alive
setInterval(() => {
    clients.forEach((client, clientId) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'ping' }));
            
            // Remove clients that haven't responded in 60 seconds
            if (Date.now() - client.lastPing > 60000) {
                console.log(`Removing inactive client: ${clientId}`);
                client.ws.close();
            }
        }
    });
}, 30000); // Every 30 seconds

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sync Wall Server running on port ${PORT}`);
    console.log(`WebSocket server ready for connections`);
    console.log(`Health check: http://localhost:${PORT}/`);
});