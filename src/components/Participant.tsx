import { useEffect, useRef, useState } from 'react';
import Video, { Participant as TwilioParticipant, TrackPublication, VideoTrack, AudioTrack } from 'twilio-video';
import { Mic, MicOff, User } from 'lucide-react';
import { cn } from '../lib/utils';
import { motion } from 'motion/react';

interface ParticipantProps {
  participant: TwilioParticipant;
  isLocal?: boolean;
  key?: string;
}

export default function Participant({ participant, isLocal = false }: ParticipantProps) {
  const [videoTracks, setVideoTracks] = useState<VideoTrack[]>([]);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [volume, setVolume] = useState(0);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const trackpubsToTracks = (trackMap: Map<string, TrackPublication>) => {
    return Array.from(trackMap.values())
      .map(publication => (publication as any).track)
      .filter(track => track !== null) as (VideoTrack | AudioTrack)[];
  };

  useEffect(() => {
    const syncTracks = () => {
      setVideoTracks(trackpubsToTracks(participant.videoTracks) as VideoTrack[]);
      setAudioTracks(trackpubsToTracks(participant.audioTracks) as AudioTrack[]);
    };

    syncTracks();

    participant.on('trackSubscribed', syncTracks);
    participant.on('trackUnsubscribed', syncTracks);
    participant.on('trackPublished', syncTracks);
    participant.on('trackUnpublished', syncTracks);

    return () => {
      participant.off('trackSubscribed', syncTracks);
      participant.off('trackUnsubscribed', syncTracks);
      participant.off('trackPublished', syncTracks);
      participant.off('trackUnpublished', syncTracks);
    };
  }, [participant]);

  // Audio Processing for Visualizer
  useEffect(() => {
    const audioTrack = audioTracks[0];
    if (audioTrack && !isAudioMuted) {
      const initAudio = () => {
        try {
          const stream = new MediaStream([audioTrack.mediaStreamTrack]);
          const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
          const analyser = audioContext.createAnalyser();
          const source = audioContext.createMediaStreamSource(stream);
          
          source.connect(analyser);
          analyser.fftSize = 256;
          
          audioContextRef.current = audioContext;
          analyserRef.current = analyser;

          const bufferLength = analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);

          const updateVolume = () => {
            if (!analyserRef.current) return;
            analyserRef.current.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
              sum += dataArray[i];
            }
            const average = sum / bufferLength;
            setVolume(average);
            rafRef.current = requestAnimationFrame(updateVolume);
          };

          updateVolume();
        } catch (e) {
          console.error('Audio visualizer failed:', e);
        }
      };

      initAudio();
    } else {
      setVolume(0);
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }

    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [audioTracks, isAudioMuted]);

  useEffect(() => {
    const videoTrack = videoTracks[0];
    const videoElement = videoRef.current;
    if (videoTrack && videoElement) {
      videoTrack.attach(videoElement);
      return () => {
        videoTrack.detach(videoElement);
        // Explicitly clear srcObject to ensure hardware release in some browsers
        if (videoElement) {
          videoElement.srcObject = null;
        }
      };
    } else if (videoElement) {
      videoElement.srcObject = null;
    }
  }, [videoTracks]);

  useEffect(() => {
    const audioTrack = audioTracks[0];
    const audioElement = audioRef.current;
    if (audioTrack && audioElement) {
      audioTrack.attach(audioElement);
      return () => {
        audioTrack.detach(audioElement);
        if (audioElement) {
          audioElement.srcObject = null;
        }
      };
    } else if (audioElement) {
      audioElement.srcObject = null;
    }
  }, [audioTracks]);

  // Check for initial audio state
  useEffect(() => {
    const checkAudio = () => {
      const audioTrack = Array.from(participant.audioTracks.values())[0]?.track;
      setIsAudioMuted(audioTrack ? !audioTrack.isEnabled : true);
    };

    checkAudio();
    participant.on('trackEnabled', (publication) => {
      if ((publication as any).kind === 'audio') setIsAudioMuted(false);
    });
    participant.on('trackDisabled', (publication) => {
      if ((publication as any).kind === 'audio') setIsAudioMuted(true);
    });
  }, [participant]);

  const hasVideo = videoTracks.length > 0;

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn(
        "relative rounded-2xl overflow-hidden bg-slate-900 border border-slate-800/50 aspect-video group transition-all duration-500",
        isLocal && "ring-2 ring-indigo-500 shadow-[0_0_20px_rgba(99,102,241,0.2)]",
        !isAudioMuted && volume > 10 && "ring-2 ring-green-500/30"
      )}
    >
      {/* Video Element */}
      <video 
        ref={videoRef} 
        autoPlay={true} 
        playsInline={true}
        className={cn(
          "w-full h-full object-cover transition-opacity duration-700",
          !hasVideo && "opacity-0"
        )}
      />

      {/* Placeholder for no video */}
      {!hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
          <div className={cn(
            "w-24 h-24 rounded-full bg-slate-800/50 border border-slate-700/50 flex items-center justify-center text-slate-500 transition-all duration-300",
            !isAudioMuted && volume > 10 ? "scale-105 border-green-500/30" : ""
          )}>
            <User size={48} strokeWidth={1} />
          </div>
        </div>
      )}

      {/* Audio Element (Hidden) */}
      <audio ref={audioRef} autoPlay={true} muted={isLocal} />

      {/* Overlay Details */}
      <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/80 via-black/20 to-transparent flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 bg-slate-950/60 backdrop-blur-md border border-white/5 rounded-lg text-slate-300">
            {participant.identity} {isLocal && '(You)'}
          </span>
          {isAudioMuted ? (
            <div className="p-1 px-2 bg-red-500/10 backdrop-blur-md border border-red-500/20 rounded-lg">
              <MicOff size={10} className="text-red-400" />
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/10 backdrop-blur-md border border-green-500/20 rounded-lg">
               <div className="flex items-end gap-0.5 h-2">
                  <div className="w-0.5 bg-green-400 rounded-full transition-all duration-75" style={{ height: `${Math.max(10, volume * 1.2)}%` }} />
                  <div className="w-0.5 bg-green-400 rounded-full transition-all duration-75 delay-75" style={{ height: `${Math.max(10, volume * 0.8)}%` }} />
                  <div className="w-0.5 bg-green-400 rounded-full transition-all duration-75 delay-150" style={{ height: `${Math.max(10, volume * 1.5)}%` }} />
               </div>
               <span className="text-[8px] font-bold text-green-400 uppercase tracking-tighter">Live</span>
            </div>
          )}
        </div>
      </div>

      {/* Status Indicators (Always visible) */}
      <div className="absolute top-4 right-4 flex gap-2">
        {isLocal && (
          <div className="px-2 py-0.5 bg-indigo-500 text-[9px] uppercase tracking-wider font-bold rounded-sm shadow-lg shadow-indigo-500/20">
            Host
          </div>
        )}
        {!isAudioMuted && (
           <div className={cn(
             "w-2 h-2 rounded-full transition-all duration-100",
             volume > 5 ? "bg-green-400 shadow-[0_0_10px_rgba(74,222,128,0.8)] scale-110" : "bg-indigo-400 shadow-[0_0_10px_rgba(129,140,248,0.8)]"
           )} />
        )}
      </div>
    </motion.div>
  );
}
