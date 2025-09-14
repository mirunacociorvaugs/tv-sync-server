const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { RateLimiterMemory } = require('rate-limiter-flexible');

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

// PIN-based pairing system
const activePins = new Map(); // pin -> {adminId, timestamp, clientIds (Set)}
const clientPairings = new Map(); // clientId -> adminId
const adminGroups = new Map(); // adminId -> Set of clientIds
const adminPins = new Map(); // adminId -> pin

// Wall configurations per admin
const wallConfigs = new Map(); // adminId -> config

// Rate limiters
const pinGenerationLimiter = new RateLimiterMemory({
    points: 3, // Number of PIN generations allowed
    duration: 60, // Per 60 seconds
});

const pinAttemptLimiter = new RateLimiterMemory({
    points: 5, // Number of PIN attempts allowed
    duration: 60, // Per 60 seconds
});

const messageLimiter = new RateLimiterMemory({
    points: 100, // Number of messages allowed
    duration: 60, // Per 60 seconds
});

// Generate a random 6-digit PIN
function generatePin() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

// Clean up expired PINs (expire after 5 minutes)
function cleanupExpiredPins() {
    const now = Date.now();
    const expireTime = 5 * 60 * 1000; // 5 minutes
    
    for (const [pin, data] of activePins.entries()) {
        if (now - data.timestamp > expireTime) {
            // Notify admin that PIN expired
            const admin = clients.get(data.adminId);
            if (admin && admin.ws && admin.ws.readyState === WebSocket.OPEN) {
                admin.ws.send(JSON.stringify({
                    type: 'pinExpired',
                    pin: pin
                }));
            }
            
            // Clean up all clients that used this PIN
            if (data.clientIds && data.clientIds.size > 0) {
                console.log(`Cleaning up ${data.clientIds.size} clients from expired PIN ${pin}`);
            }
            
            adminPins.delete(data.adminId);
            activePins.delete(pin);
        }
    }
}

// Run cleanup every minute
setInterval(cleanupExpiredPins, 60000);

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
    const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
    
    // Handle messages from client with rate limiting
    ws.on('message', async (message) => {
        try {
            // Apply rate limiting
            await messageLimiter.consume(clientId).catch((rateLimiterRes) => {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Too many requests. Please slow down.',
                    retryAfter: Math.round(rateLimiterRes.msBeforeNext / 1000) || 60
                }));
                throw new Error('Rate limit exceeded');
            });
            
            const data = JSON.parse(message);
            await handleClientMessage(clientId, data);
        } catch (error) {
            if (error.message !== 'Rate limit exceeded') {
                console.error('Error parsing message:', error);
            }
        }
    });
    
    // Handle client disconnect
    ws.on('close', () => {
        console.log(`Client disconnected: ${clientId}`);
        const client = clients.get(clientId);
        
        if (client) {
            // Clean up admin data
            if (client.mode === 'admin') {
                // Get paired clients BEFORE deleting the admin group
                const pairedClients = adminGroups.get(clientId);
                
                // Now clean up admin data
                adminClients.delete(clientId);
                adminGroups.delete(clientId);
                wallConfigs.delete(clientId);
                
                // Clean up PIN if exists
                const pin = adminPins.get(clientId);
                if (pin) {
                    const pinData = activePins.get(pin);
                    if (pinData) {
                        // Notify all clients paired with this PIN
                        if (pinData.clientIds && pinData.clientIds.size > 0) {
                            pinData.clientIds.forEach(pairedClientId => {
                                const pairedClient = clients.get(pairedClientId);
                                if (pairedClient && pairedClient.ws && pairedClient.ws.readyState === WebSocket.OPEN) {
                                    pairedClient.ws.send(JSON.stringify({
                                        type: 'unpaired',
                                        reason: 'Admin disconnected'
                                    }));
                                }
                            });
                        }
                    }
                    activePins.delete(pin);
                    adminPins.delete(clientId);
                }
                
                // Notify paired clients that admin disconnected
                if (pairedClients && pairedClients.size > 0) {
                    pairedClients.forEach(pairedClientId => {
                        const pairedClient = clients.get(pairedClientId);
                        if (pairedClient) {
                            pairedClient.pairedWith = null;
                            pairedClient.deviceIndex = null;
                            clientPairings.delete(pairedClientId);
                            
                            if (pairedClient.ws && pairedClient.ws.readyState === WebSocket.OPEN) {
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
            
            // Remove client from any PIN groups they joined
            for (const [pin, data] of activePins.entries()) {
                if (data.clientIds && data.clientIds.has(clientId)) {
                    data.clientIds.delete(clientId);
                }
            }
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
async function handleClientMessage(clientId, data) {
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
                    adminId: clientId,
                    clients: clientList,
                    pairedClients: Array.from(adminGroups.get(clientId) || [])
                }));
            }
            break;
            
        case 'generatePin':
            // Admin generates a new PIN for pairing
            if (client.mode === 'admin') {
                try {
                    // Apply rate limiting for PIN generation
                    await pinGenerationLimiter.consume(clientId);
                    
                    // Remove old PIN if exists
                    const oldPin = adminPins.get(clientId);
                    if (oldPin) {
                        activePins.delete(oldPin);
                    }
                    
                    // Generate new PIN
                    let pin;
                    do {
                        pin = generatePin();
                    } while (activePins.has(pin));
                    
                    // Store PIN
                    activePins.set(pin, {
                        adminId: clientId,
                        adminName: client.name,
                        timestamp: Date.now(),
                        clientIds: new Set()
                    });
                    adminPins.set(clientId, pin);
                    
                    // Send PIN to admin
                    client.ws.send(JSON.stringify({
                        type: 'pinGenerated',
                        pin: pin,
                        expiresIn: 300 // 5 minutes in seconds
                    }));
                    
                    console.log(`Admin ${clientId} generated PIN: ${pin}`);
                } catch (rateLimiterRes) {
                    client.ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Too many PIN generation attempts. Please wait.',
                        retryAfter: Math.round(rateLimiterRes.msBeforeNext / 1000) || 60
                    }));
                }
            }
            break;
            
        case 'enterPin':
            // Client enters PIN to pair with admin
            if (client.mode === 'client' && data.pin) {
                try {
                    // Apply rate limiting for PIN attempts
                    await pinAttemptLimiter.consume(clientId);
                    
                    const pinData = activePins.get(data.pin);
                    
                    if (pinData) {
                        // Check if PIN has expired
                        const now = Date.now();
                        if (now - pinData.timestamp > 5 * 60 * 1000) {
                            client.ws.send(JSON.stringify({
                                type: 'error',
                                message: 'PIN has expired. Please request a new one.'
                            }));
                            // Clean up expired PIN
                            adminPins.delete(pinData.adminId);
                            activePins.delete(data.pin);
                            return;
                        }
                        
                        // Valid PIN found
                        const admin = clients.get(pinData.adminId);
                        
                        if (admin && admin.ws && admin.ws.readyState === WebSocket.OPEN) {
                            // Remove any existing pairing
                            if (client.pairedWith) {
                                const oldAdminGroup = adminGroups.get(client.pairedWith);
                                if (oldAdminGroup) {
                                    oldAdminGroup.delete(clientId);
                                }
                            }
                            
                            // Pair client with admin
                            client.pairedWith = pinData.adminId;
                            clientPairings.set(clientId, pinData.adminId);
                            
                            const adminGroup = adminGroups.get(pinData.adminId);
                            if (adminGroup) {
                                adminGroup.add(clientId);
                            }
                            
                            // Add client to PIN group
                            pinData.clientIds.add(clientId);
                            
                            // Notify admin
                            admin.ws.send(JSON.stringify({
                                type: 'clientPaired',
                                clientId: clientId,
                                clientName: client.name,
                                pin: data.pin
                            }));
                            
                            // Notify client
                            client.ws.send(JSON.stringify({
                                type: 'paired',
                                adminId: pinData.adminId,
                                adminName: pinData.adminName
                            }));
                            
                            console.log(`Client ${clientId} paired with admin ${pinData.adminId} using PIN ${data.pin}`);
                            broadcastClientList();
                        } else {
                            // Admin is no longer connected
                            client.ws.send(JSON.stringify({
                                type: 'error',
                                message: 'Admin is no longer connected'
                            }));
                            // Clean up stale PIN
                            adminPins.delete(pinData.adminId);
                            activePins.delete(data.pin);
                        }
                    } else {
                        // Invalid PIN
                        client.ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Invalid or expired PIN'
                        }));
                        console.log(`Client ${clientId} entered invalid PIN: ${data.pin}`);
                    }
                } catch (rateLimiterRes) {
                    client.ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Too many PIN attempts. Please wait.',
                        retryAfter: Math.round(rateLimiterRes.msBeforeNext / 1000) || 60
                    }));
                }
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
                
                console.log(`Sync requested by admin ${clientId}`);
                console.log('Config:', config);
                console.log('Admin group size:', adminGroup ? adminGroup.size : 0);
                
                if (config) {
                    // Merge any config sent with sync command
                    const mergedConfig = { ...config, ...data.config };
                    
                    const syncData = {
                        type: 'sync',
                        config: mergedConfig,
                        syncTime: Date.now() + 2000 // Start 2 seconds from now
                    };
                    
                    // Send to admin itself
                    client.ws.send(JSON.stringify(syncData));
                    console.log(`Sent sync to admin ${clientId}`);
                    
                    // Send to all paired clients
                    if (adminGroup && adminGroup.size > 0) {
                        let successCount = 0;
                        let failCount = 0;
                        
                        adminGroup.forEach(pairedClientId => {
                            const pairedClient = clients.get(pairedClientId);
                            if (pairedClient && pairedClient.ws && pairedClient.ws.readyState === WebSocket.OPEN) {
                                try {
                                    pairedClient.ws.send(JSON.stringify(syncData));
                                    console.log(`Sent sync to client ${pairedClientId}`);
                                    successCount++;
                                } catch (error) {
                                    console.error(`Failed to send sync to client ${pairedClientId}:`, error);
                                    failCount++;
                                }
                            } else {
                                console.warn(`Client ${pairedClientId} is not connected`);
                                failCount++;
                            }
                        });
                        
                        console.log(`Sync sent: ${successCount} success, ${failCount} failed`);
                    }
                    
                    console.log(`Sync command sent from admin ${clientId} to ${adminGroup ? adminGroup.size : 0} paired clients`);
                } else {
                    console.log(`No config found for admin ${clientId}`);
                }
            }
            break;
            
        case 'unpair':
            // Handle unpair from either admin or client
            if (client.mode === 'admin' && data.clientId) {
                // Admin unpairing a client
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
            } else if (client.mode === 'client') {
                // Client unpairing themselves
                if (client.pairedWith) {
                    const adminId = client.pairedWith;
                    const adminGroup = adminGroups.get(adminId);
                    if (adminGroup) {
                        adminGroup.delete(clientId);
                    }
                    
                    client.pairedWith = null;
                    client.deviceIndex = null;
                    clientPairings.delete(clientId);
                    
                    // Notify admin
                    const admin = clients.get(adminId);
                    if (admin && admin.ws.readyState === WebSocket.OPEN) {
                        admin.ws.send(JSON.stringify({
                            type: 'clientUnpaired',
                            clientId: clientId,
                            clientName: client.name
                        }));
                    }
                    
                    broadcastClientList();
                }
            }
            break;
            
        case 'setPairingPreference':
            // Removed - no longer using direct pairing preferences with PIN system
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
                adminId: adminId,
                clients: clientList,
                pairedClients: Array.from(adminGroups.get(adminId) || [])
            }));
        }
    });
}

// Ping clients periodically to keep connections alive
setInterval(() => {
    clients.forEach((client, clientId) => {
        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.send(JSON.stringify({ type: 'ping' }));
                
                // Remove clients that haven't responded in 90 seconds (more lenient)
                if (Date.now() - client.lastPing > 90000) {
                    console.log(`Removing inactive client: ${clientId}`);
                    client.ws.close();
                }
            } catch (error) {
                console.error(`Error pinging client ${clientId}:`, error);
                // Force close if we can't ping
                try {
                    client.ws.close();
                } catch (closeError) {
                    console.error(`Error closing client ${clientId}:`, closeError);
                }
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