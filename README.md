# Sync Wall Server

WebSocket server for synchronizing video walls across multiple Samsung TVs.

## Deploy to Render.com

### Step 1: Push to GitHub
1. Create a new repository on GitHub
2. Push this folder to the repository:
```bash
cd sync-wall-server
git init
git add .
git commit -m "Initial sync wall server"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/sync-wall-server.git
git push -u origin main
```

### Step 2: Deploy on Render
1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click "New +" → "Web Service"
3. Connect your GitHub account if not already connected
4. Select your `sync-wall-server` repository
5. Fill in the details:
   - **Name**: `sync-wall` (this becomes your URL)
   - **Region**: Choose closest to you
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
6. Click "Create Web Service"

### Step 3: Get Your Server URL
After deployment (takes 2-3 minutes), you'll get a URL like:
- `https://sync-wall.onrender.com`

### Step 4: Update Your TV App
In your TV app's `js/main.js`, update the server discovery to use your Render URL:

```javascript
// Replace the serverUrl with your Render URL
serverUrl = 'wss://sync-wall.onrender.com';
```

## API Endpoints

- `/` - Health check, shows server status
- `/time` - Get server time for clock synchronization
- WebSocket at `wss://your-app.onrender.com`

## Local Development

```bash
npm install
npm start
```

Server runs on http://localhost:8080

## Free Tier Notes

- Render free tier spins down after 15 minutes of inactivity
- First request after sleep takes ~30 seconds to wake up
- Solution: Admin TV can ping every 10 minutes to keep alive

## WebSocket Protocol

### Client → Server Messages:
- `register`: Register as admin or client with device index
- `config`: Update wall configuration (admin only)
- `sync`: Send sync command to all clients (admin only)
- `ping`: Keep connection alive

### Server → Client Messages:
- `welcome`: Initial connection confirmation
- `config`: Wall configuration update
- `sync`: Synchronization command
- `clientCount`: Number of connected clients
- `pong`: Response to ping