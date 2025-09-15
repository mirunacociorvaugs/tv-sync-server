const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const { RateLimiterMemory } = require('rate-limiter-flexible');

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Data structures
const clients = new Map();        // clientId -> client data
const clientCodes = new Map();    // code -> clientId  
const connections = new Map();    // clientId -> Set of adminIds
const adminGroups = new Map();    // adminId -> Set of clientIds
const codeTimers = new Map();     // clientId -> timer reference

// Rate limiters
const connectionLimiter = new RateLimiterMemory({
    points: 5,
    duration: 60
});

// Generate secure 6-digit code
function generateClientCode() {
    return crypto.randomInt(100000, 1000000).toString();
}

// Rotate client code
function rotateClientCode(clientId) {
    const client = clients.get(clientId);
    if (!client || client.mode !== 'client') return;
    
    // Clear old code
    if (client.code) {
        clientCodes.delete(client.code);
    }
    
    // Generate new unique code
    let newCode;
    do {
        newCode = generateClientCode();
    } while (clientCodes.has(newCode));
    
    client.code = newCode;
    client.codeExpiry = Date.now() + 300000; // 5 minutes
    clientCodes.set(newCode, clientId);
    
    // Send new code to client
    if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
            type: 'codeUpdated',
            code: newCode,
            expiresIn: 300
        }));
    }
    
    console.log(`Client ${clientId} code rotated: ${newCode}`);
}

// Handle unpair with immediate propagation
function handleUnpair(initiatorId, targetId) {
    const initiator = clients.get(initiatorId);
    if (!initiator) return;
    
    if (initiator.mode === 'admin' && targetId) {
        // Admin unpairing specific client
        const group = adminGroups.get(initiatorId);
        if (group && group.has(targetId)) {
            group.delete(targetId);
            
            // Remove admin from client's connections
            const clientConnections = connections.get(targetId);
            if (clientConnections) {
                clientConnections.delete(initiatorId);
                if (clientConnections.size === 0) {
                    connections.delete(targetId);
                }
            }
            
            // Notify client immediately
            const target = clients.get(targetId);
            if (target && target.ws.readyState === WebSocket.OPEN) {
                target.ws.send(JSON.stringify({
                    type: 'unpaired',
                    adminId: initiatorId,
                    reason: 'Admin disconnected'
                }));
                target.deviceIndex = null;
            }
            
            console.log(`Admin ${initiatorId} unpaired client ${targetId}`);
        }
    } else if (initiator.mode === 'client') {
        // Client unpairing from all admins
        const connectedAdmins = connections.get(initiatorId);
        if (connectedAdmins) {
            connectedAdmins.forEach(adminId => {
                const admin = clients.get(adminId);
                if (admin && admin.ws.readyState === WebSocket.OPEN) {
                    admin.ws.send(JSON.stringify({
                        type: 'clientUnpaired', 
                        clientId: initiatorId,
                        clientName: initiator.name
                    }));
                }
                
                // Remove client from admin's group
                const group = adminGroups.get(adminId);
                if (group) {
                    group.delete(initiatorId);
                }
            });
            connections.delete(initiatorId);
            initiator.deviceIndex = null;
        }
        
        console.log(`Client ${initiatorId} unpaired from all admins`);
    }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const clientInfo = {
        id: clientId,
        ws: ws,
        mode: null,
        name: null,
        code: null,
        codeExpiry: null,
        deviceIndex: null,
        lastPing: Date.now()
    };
    
    clients.set(clientId, clientInfo);
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        clientId: clientId,
        serverTime: Date.now()
    }));
    
    console.log(`Client connected: ${clientId}`);
    
    // Handle messages
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            await handleMessage(clientId, data);
        } catch (error) {
            console.error('Message handling error:', error);
        }
    });
    
    // Handle disconnect
    ws.on('close', () => {
        console.log(`Client disconnected: ${clientId}`);
        const client = clients.get(clientId);
        
        if (client) {
            // Clear code timer
            if (codeTimers.has(clientId)) {
                clearInterval(codeTimers.get(clientId));
                codeTimers.delete(clientId);
            }
            
            // Clear code mapping
            if (client.code) {
                clientCodes.delete(client.code);
            }
            
            // Handle unpair for all connections
            if (client.mode === 'admin') {
                const group = adminGroups.get(clientId);
                if (group) {
                    group.forEach(targetId => {
                        const target = clients.get(targetId);
                        if (target && target.ws.readyState === WebSocket.OPEN) {
                            target.ws.send(JSON.stringify({
                                type: 'unpaired',
                                adminId: clientId,
                                reason: 'Admin disconnected'
                            }));
                            target.deviceIndex = null;
                        }
                        
                        // Remove from connections
                        const targetConnections = connections.get(targetId);
                        if (targetConnections) {
                            targetConnections.delete(clientId);
                        }
                    });
                }
                adminGroups.delete(clientId);
            } else if (client.mode === 'client') {
                handleUnpair(clientId);
            }
        }
        
        clients.delete(clientId);
    });
    
    ws.on('error', (error) => {
        console.error(`WebSocket error for ${clientId}:`, error);
    });
});

// Message handler
async function handleMessage(clientId, data) {
    const client = clients.get(clientId);
    if (!client) return;
    
    switch(data.type) {
        case 'register':
            client.mode = data.mode;
            client.name = data.name || `${data.mode}-${clientId.slice(-4)}`;
            
            if (data.mode === 'client') {
                // Generate initial code
                rotateClientCode(clientId);
                
                // Set up code rotation timer
                const timer = setInterval(() => {
                    rotateClientCode(clientId);
                }, 300000); // 5 minutes
                
                codeTimers.set(clientId, timer);
            } else if (data.mode === 'admin') {
                adminGroups.set(clientId, new Set());
            }
            
            console.log(`${clientId} registered as ${data.mode}`);
            break;
            
        case 'requestConnection': {
            // Admin requesting connection with client code
            if (client.mode !== 'admin') return;
            
            try {
                await connectionLimiter.consume(clientId);
            } catch (e) {
                client.ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Too many connection attempts'
                }));
                return;
            }
            
            const targetClientId = clientCodes.get(data.code);
            if (!targetClientId) {
                client.ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Invalid code'
                }));
                return;
            }
            
            const targetClient = clients.get(targetClientId);
            if (!targetClient) {
                client.ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Client not available'
                }));
                return;
            }
            
            // Send approval request to client
            targetClient.ws.send(JSON.stringify({
                type: 'connectionRequest',
                adminId: clientId,
                adminName: client.name
            }));
            
            console.log(`Admin ${clientId} requesting connection to client ${targetClientId}`);
            break;
        }
            
        case 'approveConnection':
            // Client approves admin connection
            if (client.mode !== 'client') return;
            
            const admin = clients.get(data.adminId);
            if (!admin) {
                client.ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Admin no longer available'
                }));
                return;
            }
            
            // Establish connection
            if (!connections.has(clientId)) {
                connections.set(clientId, new Set());
            }
            connections.get(clientId).add(data.adminId);
            
            if (!adminGroups.has(data.adminId)) {
                adminGroups.set(data.adminId, new Set());
            }
            adminGroups.get(data.adminId).add(clientId);
            
            // Notify both parties
            admin.ws.send(JSON.stringify({
                type: 'connected',
                clientId: clientId,
                clientName: client.name
            }));
            
            client.ws.send(JSON.stringify({
                type: 'connected',
                adminId: data.adminId,
                adminName: admin.name
            }));
            
            console.log(`Connection established: Admin ${data.adminId} <-> Client ${clientId}`);
            break;
            
        case 'rejectConnection':
            // Client rejects admin connection
            if (client.mode !== 'client') return;
            
            const rejectedAdmin = clients.get(data.adminId);
            if (rejectedAdmin && rejectedAdmin.ws.readyState === WebSocket.OPEN) {
                rejectedAdmin.ws.send(JSON.stringify({
                    type: 'connectionRejected',
                    clientId: clientId,
                    clientName: client.name
                }));
            }
            break;
            
        case 'assignIndex': {
            // Admin assigns device index to client
            if (client.mode !== 'admin') return;
            
            const targetClient = clients.get(data.clientId);
            const group = adminGroups.get(clientId);
            
            if (targetClient && group && group.has(data.clientId)) {
                targetClient.deviceIndex = data.index;
                targetClient.ws.send(JSON.stringify({
                    type: 'indexAssigned',
                    index: data.index
                }));
                
                console.log(`Device index ${data.index} assigned to client ${data.clientId}`);
            }
            break;
        }
            
        case 'unpair':
            handleUnpair(clientId, data.targetId);
            break;
            
        case 'sync':
            // Admin initiates synchronization
            if (client.mode !== 'admin') return;
            
            const syncTime = Date.now() + 2000; // Start in 2 seconds
            const syncGroup = adminGroups.get(clientId) || new Set();
            
            const syncData = {
                type: 'startSync',
                syncTime: syncTime,
                config: {
                    mediaUrl: data.mediaUrl,
                    rows: data.rows,
                    cols: data.cols,
                    mode: data.mode // 'painting' or 'unified'
                }
            };
            
            // Send to admin (with self index if set)
            client.deviceIndex = data.adminIndex;
            client.ws.send(JSON.stringify({
                ...syncData,
                deviceIndex: data.adminIndex
            }));
            
            // Send to all connected clients with their indices
            syncGroup.forEach(targetId => {
                const target = clients.get(targetId);
                if (target && target.ws.readyState === WebSocket.OPEN) {
                    target.ws.send(JSON.stringify({
                        ...syncData,
                        deviceIndex: target.deviceIndex
                    }));
                }
            });
            
            console.log(`Sync initiated by admin ${clientId} for ${syncGroup.size + 1} devices`);
            break;
            
        case 'ping':
            client.lastPing = Date.now();
            client.ws.send(JSON.stringify({ type: 'pong' }));
            break;
    }
}

// HTTP endpoints
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        clients: clients.size,
        connections: connections.size
    });
});

app.get('/time', (req, res) => {
    res.json({ time: Date.now() });
});

// Periodic ping to keep connections alive
setInterval(() => {
    clients.forEach((client, id) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'ping' }));
            
            // Remove inactive clients
            if (Date.now() - client.lastPing > 90000) {
                console.log(`Removing inactive client: ${id}`);
                client.ws.close();
            }
        }
    });
}, 30000);

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Video Wall Server running on port ${PORT}`);
});