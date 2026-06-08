import React, { useState, useEffect, useRef } from 'react';
import { Video, User, Hash, ArrowRight, LogIn, Mic, MicOff, VideoIcon, VideoOff, AlertCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';
import { auth, signInWithGoogle, db } from '../lib/firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot, deleteDoc, serverTimestamp } from 'firebase/firestore';

interface LobbyProps {
  onJoin: (identity: string, roomName: string, initialMicOn: boolean, initialVideoOn: boolean, preGeneratedUniqueId?: string) => void;
}

export default function Lobby({ onJoin }: LobbyProps) {
  const [identity, setIdentity] = useState('');
  const [roomName, setRoomName] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  // Waiting Room state variables
  const [knockStatus, setKnockStatus] = useState<'idle' | 'knocking' | 'rejected'>('idle');
  const [myGuestUniqueId, setMyGuestUniqueId] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, []);

  const handleCancelKnocking = async () => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    if (myGuestUniqueId && roomName) {
      try {
        const participantDocRef = doc(db, 'rooms', roomName.trim(), 'participants', myGuestUniqueId);
        await deleteDoc(participantDocRef);
      } catch (e) {
        console.error('Error deleting knock doc:', e);
      }
    }
    setKnockStatus('idle');
    setIsJoining(false);
    setMyGuestUniqueId(null);
  };

  const handleReturnToLobby = () => {
    setKnockStatus('idle');
    setIsJoining(false);
    setMyGuestUniqueId(null);
  };

  // Meet-style preview states
  const [micOn, setMicOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u?.displayName) {
        setIdentity(u.displayName);
      }
      setIsAuthLoading(false);
    });

    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomName(roomParam);
    }

    return () => unsub();
  }, []);

  // Handle preview stream initialization
  useEffect(() => {
    if (!user) return;
    let activeStream: MediaStream | null = null;

    const startPreview = async () => {
      if (videoOn) {
        try {
          setPreviewError(null);
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 360 },
            audio: false
          });
          activeStream = stream;
          setLocalStream(stream);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        } catch (err: any) {
          console.warn('Lobby camera preview access denied:', err);
          setPreviewError('Camera access blocked. Reset permissions to enable preview.');
          setVideoOn(false);
        }
      } else {
        setLocalStream(null);
      }
    };

    // Prompt for mic permission in lobby to pre-grant access
    if (micOn && navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(s => {
          s.getTracks().forEach(t => t.stop());
        })
        .catch(e => {
          console.warn('Lobby mic preview permission denied:', e);
        });
    }

    startPreview();

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [user, videoOn]);

  const handleSignIn = async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error('Sign in failed:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    
    if (identity.trim() && roomName.trim() && !isJoining) {
      setIsJoining(true);
      
      const targetRoom = roomName.trim();
      const targetIdentity = identity.trim();
      const generatedGuestId = `${targetIdentity}_${Math.random().toString(36).substring(2, 7)}`;

      try {
        // Query room document
        const roomDocRef = doc(db, 'rooms', targetRoom);
        const roomDocSnap = await getDoc(roomDocRef);

        let isRoomCreator = false;
        
        if (!roomDocSnap.exists()) {
          // Room does not exist, so current user creates it and is the host!
          await setDoc(roomDocRef, {
            name: targetRoom,
            createdBy: targetIdentity,
            active: true,
            createdAt: serverTimestamp()
          });
          isRoomCreator = true;
        } else {
          // Room exists, see if user is the original creator
          const roomData = roomDocSnap.data();
          if (roomData.createdBy === targetIdentity) {
            isRoomCreator = true;
          }
        }

        // If host (or host rejoining), bypass wait queue and join immediately
        if (isRoomCreator) {
          if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
          }
          await onJoin(targetIdentity, targetRoom, micOn, videoOn, generatedGuestId);
          return;
        }

        // Otherwise (it exists and we are not the creator), we are a guest knocking
        setMyGuestUniqueId(generatedGuestId);
        setKnockStatus('knocking');

        const participantDocRef = doc(db, 'rooms', targetRoom, 'participants', generatedGuestId);
        await setDoc(participantDocRef, {
          identity: generatedGuestId,
          status: 'knocking',
          joinedAt: serverTimestamp(),
          lastSeen: serverTimestamp()
        });

        const snapUnsub = onSnapshot(participantDocRef, async (docSnap) => {
          if (docSnap.exists()) {
            const partData = docSnap.data();
            if (partData.status === 'online') {
              snapUnsub();
              unsubscribeRef.current = null;
              setKnockStatus('idle');
              setIsJoining(false);
              
              if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
              }
              await onJoin(targetIdentity, targetRoom, micOn, videoOn, generatedGuestId);
            } else if (partData.status === 'rejected') {
              snapUnsub();
              unsubscribeRef.current = null;
              setKnockStatus('rejected');
              setIsJoining(false);
            }
          }
        });

        unsubscribeRef.current = snapUnsub;

      } catch (err) {
        console.error('Failed to initiate room check or knock:', err);
        alert('Verification failed. Re-access room connection.');
        setIsJoining(false);
        setKnockStatus('idle');
      }
    }
  };

  if (isAuthLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <div className="w-10 h-10 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin mb-4" />
        <p className="text-slate-500 text-xs tracking-widest uppercase">Initializing Security...</p>
      </div>
    );
  }

  if (knockStatus === 'knocking') {
    return (
      <div className="w-full max-w-md bg-slate-950/80 border border-slate-800/80 rounded-3xl p-8 shadow-2xl relative overflow-hidden backdrop-blur-xl">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-48 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
        
        <div className="text-center relative z-10 space-y-6">
          <div className="flex justify-center">
            <div className="relative flex items-center justify-center">
              <div className="absolute w-24 h-24 border-2 border-indigo-500/10 rounded-full animate-ping duration-[2000ms]" />
              <div className="absolute w-16 h-16 border border-indigo-500/20 rounded-full animate-pulse" />
              <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shadow-inner">
                <Video strokeWidth={1.5} size={28} className="animate-bounce" />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-xl font-light tracking-tight text-white">Knocking on the door...</h2>
            <p className="text-slate-400 text-xs leading-relaxed max-w-xs mx-auto">
              You are in the waiting room for <span className="font-semibold text-indigo-400">#{roomName}</span>. The meeting host will let you in shortly.
            </p>
          </div>

          <div className="pt-4">
            <button
              onClick={handleCancelKnocking}
              className="px-6 py-3 border border-slate-800/80 bg-slate-900/50 hover:bg-slate-900 text-xs font-semibold tracking-wider text-slate-400 hover:text-white rounded-xl transition-all cursor-pointer"
            >
              Cancel Request
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (knockStatus === 'rejected') {
    return (
      <div className="w-full max-w-md bg-slate-950/80 border border-red-500/20 rounded-3xl p-8 shadow-2xl relative overflow-hidden backdrop-blur-xl">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-48 bg-red-500/5 rounded-full blur-3xl pointer-events-none" />
        
        <div className="text-center relative z-10 space-y-6">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-500 shadow-inner">
              <AlertCircle strokeWidth={1.5} size={28} />
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-xl font-light tracking-tight text-white">Admission Declined</h2>
            <p className="text-slate-400 text-xs leading-relaxed max-w-xs mx-auto">
              The host of space <span className="font-semibold text-red-400">#{roomName}</span> has declined your request to join this session.
            </p>
          </div>

          <div className="pt-4">
            <button
              onClick={handleReturnToLobby}
              className="px-6 py-3 bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 text-red-400 font-semibold text-xs tracking-wider rounded-xl transition-all cursor-pointer"
            >
              Back to Lobby
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("w-full transition-all duration-500 px-4", user ? "max-w-4xl" : "max-w-md")}>
      <div className="text-center mb-10">
        <motion.div 
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 mb-4 text-indigo-400"
        >
          <Video strokeWidth={1.5} size={32} />
        </motion.div>
        
        <h1 className="text-3xl font-light tracking-tight mb-2">
          {user ? 'Configure your session' : 'Secure Entry'}
        </h1>
        <p className="text-slate-500 text-xs tracking-wider uppercase">
          {user ? 'Adjust camera / mic choices before joining your room' : 'Sign in to access secure video channels'}
        </p>
      </div>

      {!user ? (
        <div className="w-full max-w-md mx-auto">
          <motion.button
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            onClick={handleSignIn}
            className="w-full bg-white text-slate-950 font-bold py-4 px-6 rounded-2xl flex items-center justify-center gap-3 active:scale-[0.98] transition-all shadow-xl shadow-white/5 hover:bg-slate-50"
          >
            <LogIn size={20} />
            <span>Continue with Google</span>
          </motion.button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-stretch mt-4">
          
          {/* Green Room Video Preview Frame */}
          <div className="md:col-span-7 flex flex-col justify-between bg-slate-950/60 border border-slate-800/80 rounded-3xl p-4 min-h-[300px] relative overflow-hidden shadow-2xl">
            {videoOn ? (
              <video 
                ref={videoRef}
                autoPlay 
                playsInline 
                muted 
                className="absolute inset-0 w-full h-full object-cover scale-x-[-1] rounded-3xl z-0"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 text-slate-400 z-0">
                <div className="w-20 h-20 rounded-full bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-3">
                  <span className="text-3xl font-light text-indigo-300">
                    {identity ? identity.charAt(0).toUpperCase() : '?'}
                  </span>
                </div>
                <p className="text-xs text-slate-500 select-none">Camera is turned off</p>
              </div>
            )}

            {/* Live badge overlay */}
            <div className="z-10 flex items-center justify-between pointer-events-none">
              <span className="bg-slate-950/75 backdrop-blur-md text-slate-400 px-3 py-1.5 rounded-full text-[10px] font-mono tracking-wider">
                Green Room Preview
              </span>
              {videoOn && (
                <span className="flex items-center gap-1.5 bg-indigo-500 text-white px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider shadow-lg shadow-indigo-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                  Live Preview
                </span>
              )}
            </div>

            {/* Error notifications / status warnings */}
            {previewError && (
              <div className="z-10 bg-red-500/20 border border-red-500/30 text-red-200 p-3 rounded-xl flex items-center gap-2 text-xs backdrop-blur-md">
                <AlertCircle size={16} className="text-red-400 shrink-0" />
                <span>{previewError}</span>
              </div>
            )}

            {/* Media toggle hotkeys */}
            <div className="z-10 flex items-center justify-center gap-4 mt-auto pt-20">
              <button
                type="button"
                onClick={() => setMicOn(!micOn)}
                className={cn(
                  "p-3.5 rounded-full transition-all active:scale-95 shadow-xl backdrop-blur-md",
                  micOn 
                    ? "bg-slate-900/80 text-indigo-400 border border-indigo-500/20 hover:bg-slate-800"
                    : "bg-red-500/20 text-red-500 border border-red-500/30 hover:bg-red-500 hover:text-white"
                )}
                title={micOn ? "Mute Microphone" : "Unmute Microphone"}
              >
                {micOn ? <Mic size={20} /> : <MicOff size={20} />}
              </button>

              <button
                type="button"
                onClick={() => setVideoOn(!videoOn)}
                className={cn(
                  "p-3.5 rounded-full transition-all active:scale-95 shadow-xl backdrop-blur-md",
                  videoOn 
                    ? "bg-slate-900/80 text-indigo-400 border border-indigo-500/20 hover:bg-slate-800"
                    : "bg-red-500/20 text-red-500 border border-red-500/30 hover:bg-red-500 hover:text-white"
                )}
                title={videoOn ? "Turn Camera Off" : "Turn Camera On"}
              >
                {videoOn ? <VideoIcon size={20} /> : <VideoOff size={20} />}
              </button>
            </div>
          </div>

          {/* Right Column: Room Config Form */}
          <div className="md:col-span-5 flex flex-col justify-center">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-semibold px-1">
                  Identity (Google Account)
                </label>
                <div className="relative group grayscale">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-600">
                    <User size={18} />
                  </div>
                  <input
                    type="text"
                    id="lobby-identity"
                    value={identity}
                    disabled={true}
                    className="w-full bg-slate-900/50 border border-slate-800/80 rounded-2xl py-4 pl-12 pr-4 text-slate-400 opacity-60 cursor-not-allowed font-sans text-sm"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-[0.2em] text-indigo-500 font-bold px-1">
                  Enter Room Channel ID
                </label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-600 transition-colors group-focus-within:text-indigo-400">
                    <Hash size={18} />
                  </div>
                  <input
                    type="text"
                    id="lobby-room"
                    value={roomName}
                    onChange={(e) => setRoomName(e.target.value)}
                    disabled={isJoining}
                    placeholder="e.g. marketing-sync"
                    className="w-full bg-slate-950/50 border border-slate-800 rounded-2xl py-4 pl-12 pr-4 text-white placeholder:text-slate-700 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all font-sans text-sm"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                id="lobby-submit"
                disabled={isJoining || !identity.trim() || !roomName.trim()}
                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-4 px-6 rounded-2xl flex items-center justify-center gap-2 group transition-all active:scale-[0.98] shadow-lg shadow-indigo-600/20 disabled:opacity-50 disabled:scale-100 text-sm mt-3"
              >
                <span>{isJoining ? 'Securing Link...' : 'Join Fully Secure'}</span>
                {!isJoining && <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />}
              </button>
            </form>
          </div>
        </div>
      )}

      <div className="mt-12 pt-8 border-t border-slate-800/50 flex justify-between items-center text-[10px] uppercase tracking-[0.15em] text-slate-600 font-bold">
        <span>Twilio + Firebase Client UI</span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse transition-shadow duration-1000 shadow-[0_0_8px_rgba(99,102,241,0.6)]" />
          Secure Node Active
        </span>
      </div>
    </div>
  );
}
