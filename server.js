const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const RateLimiter = require('rate-limiter-flexible').RateLimiterMemory;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const PORT = process.env.PORT || 8080;
const CODE_EXPIRY_TIME = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds

// Rate limiter
const rateLimiter = new RateLimiter({
    points: 10, // Number of points
    duration: 60, // Per 60 seconds
});

// Data structures
const clients = new Map(); // clientId -> client info
const pairingCodes = new Map(); // code -> client info
const adminClientPairs = new Map(); // adminId -> Set of clientIds
const clientAdminPairs = new Map(); // clientId -> adminId

// Client class
class Client {
    constructor(ws, clientId) {
        this.ws = ws;
        this.clientId = clientId;
        this.role = null;
        this.isAlive = true;
        this.lastHeartbeat = Date.now();
        this.pairingCode = null;
        this.codeExpiry = null;
    }

    send(data) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    heartbeat() {
        this.isAlive = true;
        this.lastHeartbeat = Date.now();
    }
}

// Express middleware
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        clients: clients.size,
        uptime: process.uptime()
    });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log('New WebSocket connection');
    
    let client = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            // Rate limiting
            const rateLimitKey = req.socket.remoteAddress;
            try {
                await rateLimiter.consume(rateLimitKey);
            } catch (rejRes) {
                ws.send(JSON.stringify({
                    type: 'error',
                    error: 'Rate limit exceeded'
                }));
                return;
            }

            switch (data.type) {
                case 'register':
                    handleRegister(ws, data);
                    break;

                case 'set_role':
                    if (client || (data.clientId && clients.has(data.clientId))) {
                        client = client || clients.get(data.clientId);
                        client.role = data.role;
                        console.log(`Client ${data.clientId} set role to ${data.role}`);
                    }
                    break;

                case 'register_code':
                    handleRegisterCode(data);
                    break;

                case 'request_connection':
                    handleConnectionRequest(data);
                    break;

                case 'connection_response':
                    handleConnectionResponse(data);
                    break;

                case 'start_sync':
                    handleStartSync(data);
                    break;

                case 'unpair':
                    handleUnpair(data);
                    break;

                case 'unpair_client':
                    handleUnpairClient(data);
                    break;

                case 'ping':
                    if (client) {
                        client.heartbeat();
                        client.send({ type: 'pong' });
                    }
                    break;

                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error handling message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                error: 'Invalid message format'
            }));
        }
    });

    ws.on('close', () => {
        if (client) {
            handleDisconnect(client.clientId);
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });

    function handleRegister(ws, data) {
        const { clientId, role } = data;
        
        if (!clientId) {
            ws.send(JSON.stringify({
                type: 'error',
                error: 'Client ID required'
            }));
            return;
        }

        // Create or update client
        client = new Client(ws, clientId);
        client.role = role;
        clients.set(clientId, client);
        
        console.log(`Client registered: ${clientId} as ${role}`);

        // Send current paired clients if admin
        if (role === 'admin' && adminClientPairs.has(clientId)) {
            const pairedClients = Array.from(adminClientPairs.get(clientId))
                .map(id => ({ id, connected: clients.has(id) }));
            
            client.send({
                type: 'client_list',
                clients: pairedClients
            });
        }
    }
});

function handleRegisterCode(data) {
    const { code, clientId } = data;
    
    if (!code || !clientId) return;
    
    const client = clients.get(clientId);
    if (!client) return;

    // Clear old code if exists
    if (client.pairingCode) {
        pairingCodes.delete(client.pairingCode);
    }

    // Register new code
    client.pairingCode = code;
    client.codeExpiry = Date.now() + CODE_EXPIRY_TIME;
    pairingCodes.set(code, {
        clientId,
        expiry: client.codeExpiry
    });

    console.log(`Pairing code registered: ${code} for client ${clientId}`);
}

function handleConnectionRequest(data) {
    const { code, adminId } = data;
    
    if (!code || !adminId) {
        const admin = clients.get(adminId);
        if (admin) {
            admin.send({
                type: 'error',
                error: 'Invalid request'
            });
        }
        return;
    }

    const codeInfo = pairingCodes.get(code);
    
    if (!codeInfo) {
        const admin = clients.get(adminId);
        if (admin) {
            admin.send({
                type: 'error',
                error: 'Invalid pairing code'
            });
        }
        return;
    }

    if (Date.now() > codeInfo.expiry) {
        const admin = clients.get(adminId);
        if (admin) {
            admin.send({
                type: 'error',
                error: 'Pairing code expired'
            });
        }
        pairingCodes.delete(code);
        return;
    }

    const client = clients.get(codeInfo.clientId);
    if (!client) {
        const admin = clients.get(adminId);
        if (admin) {
            admin.send({
                type: 'error',
                error: 'Client not connected'
            });
        }
        return;
    }

    // Send connection request to client
    client.send({
        type: 'connection_request',
        adminId
    });

    console.log(`Connection request from admin ${adminId} to client ${codeInfo.clientId}`);
}

function handleConnectionResponse(data) {
    const { adminId, clientId, approved } = data;
    
    const admin = clients.get(adminId);
    const client = clients.get(clientId);
    
    if (!admin || !client) return;

    if (approved) {
        // Create pairing
        if (!adminClientPairs.has(adminId)) {
            adminClientPairs.set(adminId, new Set());
        }
        adminClientPairs.get(adminId).add(clientId);
        clientAdminPairs.set(clientId, adminId);

        admin.send({
            type: 'connection_approved',
            clientId
        });

        console.log(`Connection approved: admin ${adminId} <-> client ${clientId}`);
    } else {
        admin.send({
            type: 'connection_denied',
            clientId
        });

        console.log(`Connection denied: admin ${adminId} <-> client ${clientId}`);
    }
}

function handleStartSync(data) {
    const { adminId, videoUrl, displayMode, startTime, gridCols, gridRows } = data;
    
    if (!adminClientPairs.has(adminId)) {
        const admin = clients.get(adminId);
        if (admin) {
            admin.send({
                type: 'error',
                error: 'No clients paired'
            });
        }
        return;
    }

    const pairedClients = adminClientPairs.get(adminId);
    let gridPosition = 0;

    pairedClients.forEach(clientId => {
        const client = clients.get(clientId);
        if (client) {
            const syncCommand = {
                type: 'sync_command',
                videoUrl,
                displayMode,
                startTime
            };

            if (displayMode === 'painting') {
                syncCommand.gridCols = gridCols;
                syncCommand.gridRows = gridRows;
                syncCommand.gridPosition = gridPosition++;
            }

            client.send(syncCommand);
        }
    });

    console.log(`Sync started by admin ${adminId} for ${pairedClients.size} clients`);
}

function handleUnpair(data) {
    const { clientId } = data;
    
    // Check if this is a client unpairing from admin
    if (clientAdminPairs.has(clientId)) {
        const adminId = clientAdminPairs.get(clientId);
        clientAdminPairs.delete(clientId);
        
        if (adminClientPairs.has(adminId)) {
            adminClientPairs.get(adminId).delete(clientId);
            
            // Notify admin
            const admin = clients.get(adminId);
            if (admin) {
                admin.send({
                    type: 'client_disconnected',
                    clientId
                });
            }
        }
        
        // Notify client
        const client = clients.get(clientId);
        if (client) {
            client.send({ type: 'unpaired' });
        }
    }
    
    // Check if this is an admin unpairing all clients
    if (adminClientPairs.has(clientId)) {
        const pairedClients = adminClientPairs.get(clientId);
        
        pairedClients.forEach(pairedClientId => {
            clientAdminPairs.delete(pairedClientId);
            
            const pairedClient = clients.get(pairedClientId);
            if (pairedClient) {
                pairedClient.send({ type: 'unpaired' });
            }
        });
        
        adminClientPairs.delete(clientId);
    }

    console.log(`Unpair completed for ${clientId}`);
}

function handleUnpairClient(data) {
    const { clientId, adminId } = data;
    
    if (!adminClientPairs.has(adminId)) return;
    
    adminClientPairs.get(adminId).delete(clientId);
    clientAdminPairs.delete(clientId);
    
    // Notify client
    const client = clients.get(clientId);
    if (client) {
        client.send({ type: 'unpaired' });
    }
    
    console.log(`Admin ${adminId} unpaired client ${clientId}`);
}

function handleDisconnect(clientId) {
    console.log(`Client disconnected: ${clientId}`);
    
    // Clean up pairing codes
    const client = clients.get(clientId);
    if (client && client.pairingCode) {
        pairingCodes.delete(client.pairingCode);
    }
    
    // Handle unpair on disconnect
    handleUnpair({ clientId });
    
    // Remove client
    clients.delete(clientId);
}

// Heartbeat monitoring
setInterval(() => {
    const now = Date.now();
    
    clients.forEach((client, clientId) => {
        if (now - client.lastHeartbeat > HEARTBEAT_TIMEOUT) {
            console.log(`Client ${clientId} timed out`);
            client.ws.terminate();
            handleDisconnect(clientId);
        }
    });
    
    // Clean expired pairing codes
    pairingCodes.forEach((codeInfo, code) => {
        if (now > codeInfo.expiry) {
            pairingCodes.delete(code);
            console.log(`Pairing code ${code} expired`);
        }
    });
}, HEARTBEAT_INTERVAL);

// Start server
server.listen(PORT, () => {
    console.log(`Video Wall Server running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    
    // Close all WebSocket connections
    clients.forEach(client => {
        client.send({ type: 'server_shutdown' });
        client.ws.close();
    });
    
    wss.close(() => {
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });
});