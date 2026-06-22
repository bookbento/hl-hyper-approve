import React from "react";
import "./Mhan.css";

interface LoadingScreenProps {
  size?: number;
}

const LoadingScreen: React.FC<LoadingScreenProps> = ({ size = 200 }) => {
  return (
    <div className="loader" style={{ fontFamily: "'Caprasimo', sans-serif" }}>
      <video
        className="video-i"
        style={{ width: size, height: 'auto' }}
        src="/img/Mhan.mp4"
        autoPlay
        muted
        loop
        playsInline
      />
      <div className="loaderline" />
    </div>
  );
};


export default LoadingScreen;
