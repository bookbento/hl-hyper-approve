import React from "react";
import "./ComplexIcon.css";
import { MoonLoader } from "react-spinners";

const ComplexIcon: React.FC = () => {
  return (
    <div 
      className="loading-container" 
      style={{ fontFamily: "'Caprasimo', sans-serif" }}
    >
      <div className="text-content">
        <span className="loading-letter">L</span>
        <div className="moon-loader-wrapper">
          <MoonLoader color="#183e33" size={30} />
        </div>
        <span className="loading-letter">a</span>
        <span className="loading-letter">d</span>
        <div className="video-wrapper">
          <video
            className="video-i"
            src="/img/mran.mp4"
            autoPlay
            muted
            loop
            playsInline
          />
        </div>
        <span className="loading-letter">n</span>
        <span className="loading-letter">g</span>
        <div className="dots-group">
          <span className="jumping-dot">.</span>
          <span className="jumping-dot delay-1">.</span>
          <span className="jumping-dot delay-2">.</span>
        </div>
      </div>
    </div>
  );
};

export default ComplexIcon;