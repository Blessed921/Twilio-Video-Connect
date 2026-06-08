import React, { useEffect, useState, useCallback, useRef } from 'react';
import Video, { Room as TwilioRoom, LocalParticipant, LocalVideoTrack, LocalDataTrack, RemoteParticipant } from 'twilio-video';
import { 
  Mic, MicOff, Video as VideoIcon, VideoOff, 
  ScreenShare, PhoneOff, MessageSquare, Users,
  ChevronRight, Maximize2, X, Share2, Check
} from 'lucide-react';
import Participant from './Participant';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { Message } from '../types';
import { db, auth } from '../lib/firebase';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, onSnapshot, collection, deleteDoc } from 'firebase/firestore';

interface RoomProps {
  token: string;
  roomName: string;
  identity: string;
  initialMicOn?: boolean;
  initialVideoOn?: boolean;
  onLeave: () => void;
}

export default function Room({ token, roomName, identity, initialMicOn = true, initialVideoOn = true, onLeave }: RoomProps) {
  const [room, setRoom] = useState<TwilioRoom | null>(null);
  const [participants, setParticipants] = useState<RemoteParticipant[]>([]);
  const [isMicOn, setIsMicOn] = useState(initialMicOn);
  const [isVideoOn, setIsVideoOn] = useState(initialVideoOn);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [permissionError, setPermissionError] = useState<{ type: 'camera' | 'microphone', message: string } | null>(null);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  
  const [isHost, setIsHost] = useState(false);
  const [knockingRequests, setKnockingRequests] = useState<any[]>([]);

  useEffect(() => {
    const checkHostStatus = async () => {
      try {
        const roomDoc = await getDoc(doc(db, 'rooms', roomName));
        if (roomDoc.exists()) {
          const data = roomDoc.data();
          if (data.createdBy && identity.startsWith(data.createdBy)) {
            setIsHost(true);
          }
        }
      } catch (e) {
        console.error('Error checking host status:', e);
      }
    };
    checkHostStatus();
  }, [roomName, identity]);

  useEffect(() => {
    if (!roomName) return;
    const participantsCol = collection(db, 'rooms', roomName, 'participants');
    const unsubscribe = onSnapshot(participantsCol, (snapshot) => {
      const knocking: any[] = [];
      snapshot.forEach(d => {
        const data = d.data();
        if (data.status === 'knocking') {
          knocking.push({
            id: d.id,
            ...data
          });
        }
      });
      setKnockingRequests(knocking);
    });
    return () => unsubscribe();
  }, [roomName]);

  const admitGuest = async (guestUniqueId: string) => {
    try {
      const participantDocRef = doc(db, 'rooms', roomName, 'participants', guestUniqueId);
      await updateDoc(participantDocRef, {
        status: 'online',
        lastSeen: serverTimestamp()
      });
    } catch (e) {
      console.error('Error admitting guest:', e);
    }
  };

  const rejectGuest = async (guestUniqueId: string) => {
    try {
      const participantDocRef = doc(db, 'rooms', roomName, 'participants', guestUniqueId);
      await updateDoc(participantDocRef, {
        status: 'rejected',
        lastSeen: serverTimestamp()
      });
    } catch (e) {
      console.error('Error rejecting guest:', e);
    }
  };
  
  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsElapsed(prev => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatDuration = (totalSeconds: number) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return [
      hrs.toString().padStart(2, '0'),
      mins.toString().padStart(2, '0'),
      secs.toString().padStart(2, '0')
    ].join(':');
  };
  
  const localDataTrackRef = useRef<LocalDataTrack | null>(null);
  const localVideoTrackRef = useRef<LocalVideoTrack | null>(null);
  const localAudioTrackRef = useRef<any | null>(null);
  const screenTrackRef = useRef<LocalVideoTrack | null>(null);

  const roomRef = useRef<TwilioRoom | null>(null);

  const stopLocalTracks = useCallback(() => {
    console.log('Stopping all local tracks...');
    [localVideoTrackRef.current, localAudioTrackRef.current, screenTrackRef.current].forEach(track => {
      if (track) {
        try {
          if (typeof (track as any).stop === 'function') (track as any).stop();
          if ((track as any).mediaStreamTrack) {
            (track as any).mediaStreamTrack.stop();
          }
        } catch (e) {
          console.error('Error stopping track:', e);
        }
      }
    });
    localVideoTrackRef.current = null;
    localAudioTrackRef.current = null;
    screenTrackRef.current = null;
  }, []);

  const handleLeave = useCallback(async () => {
    console.log('Handling leave...');
    
    // Clear Firestore presence
    try {
      const participantDocRef = doc(db, 'rooms', roomName, 'participants', identity);
      await deleteDoc(participantDocRef);
    } catch (e) {
      console.error('Error removing presence on leave:', e);
    }

    if (roomRef.current) {
      try {
        roomRef.current.localParticipant.tracks.forEach(publication => {
          const track = publication.track;
          if (track) {
            if (typeof (track as any).stop === 'function') (track as any).stop();
            if ((track as any).mediaStreamTrack) (track as any).mediaStreamTrack.stop();
          }
        });
        roomRef.current.disconnect();
      } catch (e) {
        console.error('Error during room disconnect:', e);
      }
      roomRef.current = null;
    }
    stopLocalTracks();
    onLeave();
  }, [onLeave, stopLocalTracks]);

  useEffect(() => {
    window.addEventListener('beforeunload', handleLeave);
    let isMounted = true;
    
    const participantConnected = (participant: RemoteParticipant) => {
      if (!isMounted) return;
      setParticipants(prevParticipants => {
        if (prevParticipants.find(p => p.sid === participant.sid)) return prevParticipants;
        return [...prevParticipants, participant];
      });
      
      participant.on('trackSubscribed', track => {
        if (track.kind === 'data') {
          track.on('message', (data: string) => {
            const message = JSON.parse(data) as Message;
            setMessages(prev => [...prev, message]);
          });
        }
      });
    };

    const participantDisconnected = (participant: RemoteParticipant) => {
      setParticipants(prevParticipants =>
        prevParticipants.filter(p => p.sid !== participant.sid)
      );
    };

    const joinRoom = async () => {
      try {
        // Register session in Firestore
        const roomDocRef = doc(db, 'rooms', roomName);
        await setDoc(roomDocRef, {
          name: roomName,
          active: true,
          updatedAt: serverTimestamp()
        }, { merge: true });

        const participantDocRef = doc(db, 'rooms', roomName, 'participants', identity);
        await setDoc(participantDocRef, {
          identity,
          status: 'online',
          joinedAt: serverTimestamp(),
          lastSeen: serverTimestamp()
        }, { merge: true });

        // Presence heartbeat
        const heartbeatInterval = setInterval(async () => {
          if (isMounted) {
            try {
              await updateDoc(participantDocRef, {
                lastSeen: serverTimestamp()
              });
            } catch (e) {
              console.error('Presence fail:', e);
            }
          }
        }, 10000);

        const localDataTrack = new LocalDataTrack();
        localDataTrackRef.current = localDataTrack;

        let localTracks: any[] = [];
        let audioTrack: any = null;
        let videoTrack: any = null;

        // Try to get audio first if enabled
        if (initialMicOn) {
          try {
            audioTrack = await Video.createLocalAudioTrack();
            localTracks.push(audioTrack);
            localAudioTrackRef.current = audioTrack;
          } catch (e: any) {
            console.warn('Microphone access denied or not available:', e);
            const isPermissionError = e.name === 'NotAllowedError' || 
                                    (e.message && e.message.toLowerCase().includes('permission denied'));
            if (isPermissionError && isMounted) {
              setPermissionError({ 
                type: 'microphone', 
                message: 'Microphone access is blocked by your browser settings.' 
              });
            }
          }
        }

        // Try to get video second if enabled
        if (initialVideoOn) {
          try {
            videoTrack = await Video.createLocalVideoTrack({
              width: { ideal: 1280 },
              height: { ideal: 720 }
            });
            localTracks.push(videoTrack);
            localVideoTrackRef.current = videoTrack;
          } catch (e: any) {
            console.warn('Camera access denied or not available:', e);
            const isPermissionError = e.name === 'NotAllowedError' || 
                                    (e.message && e.message.toLowerCase().includes('permission denied'));
            if (isPermissionError && isMounted) {
              setPermissionError({ 
                type: 'camera', 
                message: 'Camera access is blocked by your browser settings.' 
              });
            }
          }
        }

        if (!isMounted) {
          localTracks.forEach(t => {
            try {
              if (typeof (t as any).stop === 'function') (t as any).stop();
              if ((t as any).mediaStreamTrack) (t as any).mediaStreamTrack.stop();
            } catch (e) {}
          });
          return;
        }

        const newRoom = await Video.connect(token, {
          name: roomName,
          tracks: [...localTracks, localDataTrack],
          insights: false,
          bandwidthProfile: {
            video: {
              mode: 'collaboration',
              dominantSpeakerPriority: 'high'
            }
          },
          dominantSpeaker: true,
          networkQuality: {
            local: 1,
            remote: 1
          }
        });

        if (!isMounted) {
          newRoom.disconnect();
          return;
        }

        roomRef.current = newRoom;
        setRoom(newRoom);
        setParticipants(Array.from(newRoom.participants.values()));

        newRoom.on('participantConnected', participantConnected);
        newRoom.on('participantDisconnected', participantDisconnected);
        
        newRoom.participants.forEach(participant => {
          participant.on('trackSubscribed', track => {
            if (track.kind === 'data') {
              track.on('message', (data: string) => {
                const message = JSON.parse(data) as Message;
                setMessages(prev => [...prev, message]);
              });
            }
          });
        });

        setIsMicOn(!!audioTrack);
        setIsVideoOn(!!videoTrack);

      } catch (error: any) {
        console.error('Error connecting to room:', error);
        if (isMounted) {
          alert(`Connection Error: ${error.message || 'Unknown error'}`);
          onLeave();
        }
      }
    };

    joinRoom();

    return () => {
      isMounted = false;
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
      }
      stopLocalTracks();
      window.removeEventListener('beforeunload', handleLeave);
    };
  }, [token, roomName, onLeave]); // Dependencies simplified to prevent loops

  const toggleMic = useCallback(async () => {
    const currentRoom = roomRef.current;
    if (!currentRoom) return;

    const audioTracks = Array.from(currentRoom.localParticipant.audioTracks.values());
    
    if (audioTracks.length > 0) {
      audioTracks.forEach((publication: any) => {
        if (isMicOn) {
          publication.track.disable();
        } else {
          publication.track.enable();
        }
      });
      setIsMicOn(!isMicOn);
    } else {
      // Mic is off because no track exists, try to turn it ON
      try {
        console.log('Attempting to resume microphone...');
        const tracks = await Video.createLocalTracks({ audio: true });
        const microphoneTrack = tracks.find(t => t.kind === 'audio');
        if (microphoneTrack) {
          localAudioTrackRef.current = microphoneTrack;
          await currentRoom.localParticipant.publishTrack(microphoneTrack);
          setIsMicOn(true);
        }
      } catch (err: any) {
        console.error('Error accessing microphone:', err);
        const isPermissionError = err.name === 'NotAllowedError' || 
                                (err.message && err.message.toLowerCase().includes('permission denied'));
        
        if (isPermissionError) {
          setPermissionError({ 
            type: 'microphone', 
            message: 'Microphone access is blocked by your browser. Click the "Lock" or "Microphone" icon in the address bar and change setting to "Allow".' 
          });
        } else {
          alert(`Could not access microphone: ${err.message || 'Unknown error'}`);
        }
      }
    }
  }, [isMicOn]);

  const toggleVideo = useCallback(async () => {
    const currentRoom = roomRef.current;
    if (!currentRoom) return;

    if (isVideoOn) {
      // Turn OFF
      if (localVideoTrackRef.current) {
        const track = localVideoTrackRef.current;
        try {
          currentRoom.localParticipant.unpublishTrack(track);
          track.stop();
          if (track.mediaStreamTrack) {
            track.mediaStreamTrack.stop();
          }
        } catch (e) {
          console.error('Error unpublishing camera track:', e);
        }
        localVideoTrackRef.current = null;
      }
      
      // Fallback: search for any video track that isn't the screen share
      currentRoom.localParticipant.videoTracks.forEach((pub: any) => {
        const track = pub.track;
        if (track && track !== screenTrackRef.current) {
          try {
            currentRoom.localParticipant.unpublishTrack(track);
            track.stop();
            if (track.mediaStreamTrack) track.mediaStreamTrack.stop();
          } catch (e) {}
        }
      });

      setIsVideoOn(false);
    } else {
      // Turn ON
      try {
        console.log('Attempting to resume video...');
        
        // Try with standard constraints first
        const track = await Video.createLocalVideoTrack({
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 24 }
        });
        
        localVideoTrackRef.current = track;
        await currentRoom.localParticipant.publishTrack(track);
        setIsVideoOn(true);
      } catch (err: any) {
        console.error('Error resuming video:', err);
        
        // Fallback: try with NO constraints if previous failed
        try {
          console.log('Retrying video with no constraints...');
          const track = await Video.createLocalVideoTrack();
          localVideoTrackRef.current = track;
          await currentRoom.localParticipant.publishTrack(track);
          setIsVideoOn(true);
          return;
        } catch (retryErr: any) {
          console.error('Retry video failed:', retryErr);
        }

        const errorMessage = err.message || '';
        const isPermissionError = err.name === 'NotAllowedError' || 
                                errorMessage.toLowerCase().includes('permission denied') ||
                                errorMessage.toLowerCase().includes('notallowed');

        if (isPermissionError) {
          setPermissionError({ 
            type: 'camera', 
            message: 'Camera access is blocked by your browser. Click the "Lock" or "Camera" icon in the address bar and change setting to "Allow".' 
          });
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          alert('No camera found. Please connect a camera and try again.');
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          alert('Camera is in use by another application.');
        } else {
          alert(`Could not access camera: ${err.message || 'Unknown error'}`);
        }
      }
    }
  }, [isVideoOn]);

  const toggleScreenShare = useCallback(async () => {
    const currentRoom = roomRef.current;
    if (!currentRoom) return;

    if (!isScreenSharing) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true
        });
        const screenTrack = new LocalVideoTrack(stream.getTracks()[0]);
        screenTrackRef.current = screenTrack;
        currentRoom.localParticipant.publishTrack(screenTrack);
        setIsScreenSharing(true);

        screenTrack.mediaStreamTrack.onended = () => {
          currentRoom.localParticipant.unpublishTrack(screenTrack);
          screenTrack.stop();
          if (screenTrack.mediaStreamTrack) screenTrack.mediaStreamTrack.stop();
          setIsScreenSharing(false);
          screenTrackRef.current = null;
        };
      } catch (err: any) {
        if (err.name === 'NotAllowedError') {
          console.warn('User denied screen sharing permission');
        } else {
          console.error('Screen sharing error:', err);
          alert('Failed to start screen sharing: ' + (err.message || 'Unknown error'));
        }
        setIsScreenSharing(false);
      }
    } else {
      if (screenTrackRef.current) {
        currentRoom.localParticipant.unpublishTrack(screenTrackRef.current);
        screenTrackRef.current.stop();
        if (screenTrackRef.current.mediaStreamTrack) {
          screenTrackRef.current.mediaStreamTrack.stop();
        }
        screenTrackRef.current = null;
      }
      setIsScreenSharing(false);
    }
  }, [isScreenSharing]);

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (chatInput.trim() && localDataTrackRef.current) {
      const message: Message = {
        id: crypto.randomUUID(),
        author: identity,
        content: chatInput.trim(),
        timestamp: Date.now(),
      };
      
      localDataTrackRef.current.send(JSON.stringify(message));
      setMessages(prev => [...prev, message]);
      setChatInput('');
    }
  };

  const copyInviteLink = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomName);
    navigator.clipboard.writeText(url.toString());
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  }, [roomName]);

  if (!room) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <div className="w-12 h-12 border-4 border-orange-500/20 border-t-orange-500 rounded-full animate-spin mb-4" />
        <p className="text-gray-500 font-medium animate-pulse">Initializing encrypted connection...</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#020617] text-slate-200">
      {/* Main Content */}
      <div className="flex-1 flex flex-col relative overflow-hidden">
        {/* Permission Error Overlay */}
        <AnimatePresence>
          {permissionError && (
            <motion.div 
              initial={{ y: -20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -20, opacity: 0 }}
              className="absolute top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-md px-4"
            >
              <div className="bg-red-500 text-white p-4 rounded-2xl shadow-2xl flex items-start gap-3 border border-red-400">
                <div className="p-2 bg-white/20 rounded-lg">
                  {permissionError.type === 'camera' ? <VideoOff size={18} /> : <MicOff size={18} />}
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-bold">Hardware Blocked</h3>
                  <p className="text-xs text-red-50 mt-1 leading-relaxed">
                    {permissionError.message}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button 
                      onClick={() => window.location.reload()}
                      className="text-[10px] bg-white text-red-600 px-3 py-1.5 rounded-lg font-bold hover:bg-red-50 transition-colors"
                    >
                      Refresh Page
                    </button>
                    <p className="text-[9px] text-red-100 italic">
                      Click the Lock icon in URL bar to reset
                    </p>
                  </div>
                </div>
                <button 
                  onClick={() => setPermissionError(null)}
                  className="p-1 hover:bg-white/10 rounded-full transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Host Admissions Waiting Room Overlay */}
        <AnimatePresence>
          {isHost && knockingRequests.length > 0 && (
            <motion.div 
              initial={{ x: 100, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 100, opacity: 0 }}
              className="absolute top-20 right-4 z-[45] w-full max-w-sm px-4"
            >
              <div className="bg-slate-900/95 border border-indigo-500/30 backdrop-blur-2xl text-slate-200 p-5 rounded-2xl shadow-2xl space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-pulse" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-indigo-400">Waiting Room Knocks ({knockingRequests.length})</h3>
                  </div>
                  <span className="text-[10px] text-slate-500 font-medium">As Host, you manage entry</span>
                </div>

                <div className="space-y-3 max-h-48 overflow-y-auto scrollbar-hide">
                  {knockingRequests.map((req) => {
                    const humanName = req.identity.split('_')[0];
                    return (
                      <div key={req.id} className="flex items-center justify-between bg-slate-950/80 p-3 rounded-xl border border-slate-800">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 rounded-lg flex items-center justify-center text-xs font-bold uppercase">
                            {humanName.charAt(0)}
                          </div>
                          <div>
                            <p className="text-xs font-bold text-white leading-tight">{humanName}</p>
                            <p className="text-[9px] text-slate-500 font-mono">Wants to join</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => admitGuest(req.id)}
                            className="bg-indigo-600 hover:bg-indigo-550 text-white rounded-lg px-2.5 py-1.5 text-[10px] font-bold transition-all cursor-pointer"
                          >
                            Admit
                          </button>
                          <button
                            onClick={() => rejectGuest(req.id)}
                            className="bg-slate-900 border border-slate-800 hover:bg-red-950/20 hover:text-red-400 hover:border-red-500/20 text-slate-400 rounded-lg px-2.5 py-1.5 text-[10px] font-bold transition-all cursor-pointer"
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Header */}
        <div className="h-16 px-6 border-b border-slate-800/50 flex items-center justify-between bg-slate-950/40 backdrop-blur-xl z-20">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-gradient-to-br from-indigo-600 to-cyan-500 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <VideoIcon size={20} className="text-white" />
            </div>
            <div>
              <h2 className="text-sm font-semibold tracking-tight">{roomName}</h2>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Live Connection Active</span>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-6">
             <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500/10 border border-indigo-500/20 rounded-full">
               <div className="w-2 h-2 rounded-full bg-indigo-500" />
               <span className="text-xs font-mono text-indigo-400 select-none">{formatDuration(secondsElapsed)}</span>
             </div>
             <div className="flex -space-x-2">
                {[room.localParticipant, ...participants].slice(0, 3).map((p, i) => (
                  <div key={p.sid || 'local'} className="w-8 h-8 rounded-full bg-slate-800 border-2 border-slate-950 flex items-center justify-center text-[10px] font-bold text-slate-300">
                    {p.identity.charAt(0).toUpperCase()}
                  </div>
                ))}
                {participants.length > 2 && (
                  <div className="w-8 h-8 rounded-full bg-indigo-600 text-white border-2 border-slate-950 flex items-center justify-center text-[10px] font-bold">
                    +{participants.length - 2}
                  </div>
                )}
             </div>
          </div>
        </div>

        {/* Video Stage */}
        <div className="flex-1 overflow-y-auto p-4 scrollbar-hide">
          <div className={cn(
            "grid gap-4 h-full",
            participants.length === 0 ? "grid-cols-1 place-items-center max-w-4xl mx-auto" : 
            participants.length === 1 ? "grid-cols-1 md:grid-cols-2" :
            participants.length === 2 ? "grid-cols-1 md:grid-cols-3" :
            "grid-cols-2 lg:grid-cols-3"
          )}>
            <Participant 
              participant={room.localParticipant} 
              isLocal={true} 
            />
            {participants.map(p => (
              <Participant 
                key={p.sid} 
                participant={p} 
              />
            ))}
          </div>
        </div>

        {/* Controls Overlay */}
        <div className="h-20 shrink-0 flex items-center justify-center px-6 z-30">
          <motion.div 
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="flex items-center gap-4 p-3 bg-slate-900/80 backdrop-blur-2xl border border-slate-700/50 px-6 py-3 rounded-full shadow-2xl"
          >
            <button
              onClick={toggleMic}
              className={cn(
                "p-3 rounded-full transition-all active:scale-95",
                isMicOn ? "bg-slate-800 text-slate-300 hover:bg-slate-700" : "bg-red-600/20 text-red-500 hover:bg-red-600 hover:text-white"
              )}
            >
              {isMicOn ? <Mic size={20} /> : <MicOff size={20} />}
            </button>

            <button
              onClick={toggleVideo}
              className={cn(
                "p-3 rounded-full transition-all active:scale-95",
                isVideoOn ? "bg-slate-800 text-slate-300 hover:bg-slate-700" : "bg-red-600/20 text-red-500 hover:bg-red-600 hover:text-white"
              )}
            >
              {isVideoOn ? <VideoIcon size={20} /> : <VideoOff size={20} />}
            </button>

            <button
              onClick={toggleScreenShare}
              className={cn(
                "p-3 rounded-full transition-all active:scale-95",
                isScreenSharing ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 ring-4 ring-indigo-500/10" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              )}
            >
              <ScreenShare size={20} />
            </button>

            <button
              onClick={copyInviteLink}
              className={cn(
                "p-3 rounded-full transition-all active:scale-95 flex items-center gap-2",
                isCopied ? "bg-green-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              )}
              title="Copy invite link"
            >
              {isCopied ? <Check size={20} /> : <Share2 size={20} />}
            </button>

            <div className="w-[1px] h-8 bg-slate-800 mx-1" />

            <button
              onClick={() => setIsChatOpen(!isChatOpen)}
              className={cn(
                "p-3 rounded-full transition-all active:scale-95 relative",
                isChatOpen ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              )}
            >
              <MessageSquare size={20} />
              {!isChatOpen && messages.length > 0 && (
                 <span className="absolute top-0 right-0 w-3 h-3 bg-indigo-500 rounded-full border-2 border-[#0a0a0a]" />
              )}
            </button>

            <button
              onClick={handleLeave}
              className="p-3 bg-red-600/20 text-red-500 rounded-full hover:bg-red-600 hover:text-white transition-all active:scale-95"
            >
              <PhoneOff size={20} />
            </button>
          </motion.div>
        </div>
      </div>

      {/* Chat Sidebar */}
      <AnimatePresence>
        {isChatOpen && (
          <motion.div
            initial={{ x: 400 }}
            animate={{ x: 0 }}
            exit={{ x: 400 }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="w-80 bg-slate-950/60 border-l border-slate-800/50 flex flex-col z-40 backdrop-blur-md"
          >
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex flex-col">
                <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400">Room Chat</h2>
                <span className="text-[9px] text-slate-500 mt-0.5">{participants.length + 1} participants online</span>
              </div>
              <button 
                onClick={() => setIsChatOpen(false)}
                className="p-1.5 text-slate-500 hover:text-white transition-colors"
                title="Close chat"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center px-4">
                  <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-600 mb-4 transition-transform hover:scale-105">
                    <MessageSquare size={32} strokeWidth={1} />
                  </div>
                  <p className="text-xs text-slate-500 font-medium">No messages yet. Start the conversation!</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <div 
                    key={msg.id} 
                    className="space-y-1"
                  >
                    <div className="flex items-center gap-2">
                       <span className={cn(
                         "text-[11px] font-bold",
                         msg.author === identity ? "text-indigo-400" : "text-slate-400"
                       )}>
                         {msg.author}
                       </span>
                       <span className="text-[9px] text-slate-600">
                         {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                       </span>
                    </div>
                    <p className={cn(
                      "text-xs leading-relaxed p-2 rounded-lg border",
                      msg.author === identity 
                        ? "bg-indigo-500/10 border-indigo-500/20 text-indigo-100" 
                        : "bg-slate-900/80 border-slate-800 text-slate-300"
                    )}>
                      {msg.content}
                    </p>
                  </div>
                ))
              )}
            </div>

            <div className="p-3 bg-slate-900/50 border-t border-slate-800">
              <form onSubmit={sendMessage} className="relative group">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Message group..."
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage(e)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-xs text-white placeholder:text-slate-700 focus:outline-none focus:border-indigo-500/50 transition-all"
                />
                <button
                  type="submit"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-indigo-400 transition-colors"
                >
                  <ChevronRight size={16} />
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
