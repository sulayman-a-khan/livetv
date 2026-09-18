"use client";

import { useEffect, useState } from "react";
import { shouldShowAd, recordAdShown, AD_CONFIG } from "@/lib/adConfig";
import { X, Volume2, VolumeX, ShieldAlert } from "lucide-react";

export default function AdManager() {
  const [showAdModal, setShowAdModal] = useState(false);
  const [countdown, setCountdown] = useState(AD_CONFIG.adDurationSeconds);
  const [canSkip, setCanSkip] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    // Check 24-hour frequency cap from localStorage
    if (shouldShowAd()) {
      setShowAdModal(true);
    }
  }, []);

  useEffect(() => {
    if (!showAdModal) return;

    // Enable skip button after 5 seconds
    const skipTimer = setTimeout(() => {
      setCanSkip(true);
    }, 5000);

    // Countdown interval
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          closeAd();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      clearTimeout(skipTimer);
      clearInterval(interval);
    };
  }, [showAdModal]);

  const closeAd = () => {
    recordAdShown();
    setShowAdModal(false);
  };

  if (!showAdModal) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4">
      <div className="glass-panel w-full max-w-2xl rounded-2xl overflow-hidden border border-slate-700 shadow-2xl relative">
        {/* Header Bar */}
        <div className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-brand-500" />
            <span className="text-xs font-bold text-white uppercase tracking-wider">
              {AD_CONFIG.adTitle}
            </span>
            <span className="px-2 py-0.5 rounded text-[10px] bg-brand-500/20 text-brand-400 font-mono">
              24h Capped
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsMuted(!isMuted)}
              className="text-slate-400 hover:text-white transition-colors"
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>

            {canSkip ? (
              <button
                onClick={closeAd}
                className="flex items-center gap-1.5 px-3 py-1 bg-brand-600 hover:bg-brand-500 text-white rounded-lg text-xs font-bold transition-colors"
              >
                <span>Skip Ad</span>
                <X className="w-3.5 h-3.5" />
              </button>
            ) : (
              <span className="text-xs text-slate-400 font-mono">
                Skip in {Math.max(0, countdown - (AD_CONFIG.adDurationSeconds - 5))}s
              </span>
            )}
          </div>
        </div>

        {/* Video Player Frame */}
        <div className="relative aspect-video w-full bg-black">
          <video
            src={AD_CONFIG.adVideoUrl}
            autoPlay
            muted={isMuted}
            playsInline
            className="w-full h-full object-contain"
            onEnded={closeAd}
          />

          <div className="absolute bottom-3 left-3 bg-black/70 px-3 py-1 rounded-full backdrop-blur-sm border border-slate-800">
            <span className="text-xs text-slate-300 font-mono">Ad Ends in {countdown}s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
