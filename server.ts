import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;
const ChatGrant = AccessToken.ChatGrant;

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API route for generating Twilio tokens
  app.post('/api/token', (req, res) => {
    const { identity, roomName } = req.body;

    if (!identity || !roomName) {
      return res.status(400).json({ error: 'Identity and roomName are required' });
    }

    console.log(`Generating token for identity: ${identity}, room: ${roomName}`);
    
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKeySid = process.env.TWILIO_API_KEY_SID;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;

    if (!accountSid || !apiKeySid || !apiKeySecret || accountSid.includes('xxxx')) {
      console.error('Twilio credentials are missing or invalid placeholders');
      return res.status(500).json({ error: 'Twilio credentials are not configured correctly' });
    }

    try {
      // Create an access token
      const token = new AccessToken(
        accountSid,
        apiKeySid,
        apiKeySecret,
        { 
          identity: identity,
          ttl: 3600 // 1 hour
        }
      );

      // Create a VideoGrant
      const videoGrant = new VideoGrant({
        room: roomName,
      });
      token.addGrant(videoGrant);

      const jwt = token.toJwt();
      return res.json({ token: jwt });
    } catch (err) {
      console.error('Error creating token:', err);
      return res.status(500).json({ error: 'Failed to create token' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Error starting server:', err);
  process.exit(1);
});
