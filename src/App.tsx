/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import Lobby from './components/Lobby';
import Room from './components/Room';
import { motion, AnimatePresence } from 'motion/react';

export default function App() {
  const [roomName, setRoomName] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [initialMicOn, setInitialMicOn] = useState(true);
  const [initialVideoOn, setInitialVideoOn] = useState(true);

  const handleJoin = useCallback(async (identity: string, roomName: string, initialMicOn: boolean, initialVideoOn: boolean) => {
    try {
      setInitialMicOn(initialMicOn);
      setInitialVideoOn(initialVideoOn);
      const uniqueIdentity = `${identity}_${Math.random().toString(36).substring(2, 7)}`;
      const response = await fetch('/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ identity: uniqueIdentity, roomName }),
      });

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error);
      }

      setIdentity(uniqueIdentity);
      setRoomName(roomName);
      setToken(data.token);
    } catch (error) {
      console.error('Failed to join room:', error);
      alert('Failed to connect. Please check your Twilio credentials.');
    }
  }, []);

  const handleLeave = useCallback(() => {
    setToken(null);
    setRoomName(null);
    setIdentity(null);
  }, []);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-200 font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <AnimatePresence mode="wait">
        {!token ? (
          <motion.div
            key="lobby"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex items-center justify-center min-h-screen p-4"
          >
            <Lobby onJoin={handleJoin} />
          </motion.div>
        ) : (
          <motion.div
            key="room"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-screen overflow-hidden"
          >
            <Room 
              token={token} 
              roomName={roomName!} 
              identity={identity!} 
              initialMicOn={initialMicOn}
              initialVideoOn={initialVideoOn}
              onLeave={handleLeave} 
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
