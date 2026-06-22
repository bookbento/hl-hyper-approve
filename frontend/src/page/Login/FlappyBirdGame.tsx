// src/components/FlappyBirdGame.tsx
import React, { useRef, useEffect, useState } from "react";

interface Props {
  score: number;
  onScoreUp: () => void;
}

const FlappyBirdGame: React.FC<Props> = ({ score, onScoreUp }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gameOver, setGameOver] = useState(false);
  const [restartCount, setRestartCount] = useState(0);
  const scoreRef = useRef(score);

  // Sync scoreRef for real-time display
  useEffect(() => {
    scoreRef.current = score;
  }, [score]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const width = 320;
    const height = 480;
    canvas.width = width;
    canvas.height = height;

    // Theme colors
    const colors = {
      skyTop: "#1a2f4d", // สีฟ้าเข้มโทนกลางคืน
      skyBottom: "#4b86b4", // สีฟ้าโทนทะเล
      ground: "#2d5a3d", // สีเขียวเข้ม
      pipe: "#3aa655", // สีท่อแบบ neon
      pipeHighlight: "#90EE90", // สีไฮไลท์สดใส
      scoreText: "#FFD700", // สีทอง
      mountain: "#4a708b", // สีภูเขา
      cloudHighlight: "rgba(255,255,255,0.9)", // เอฟเฟกต์เมฆสว่าง
    };

    // Load character and wing images
    const charImg = new Image();
    charImg.src = "/img/Image.png"; // ใส่ path รูปหน้าคุณ
    const wingImg = new Image();
    wingImg.src = "/img/pngegg.png"; // ปีกเดี่ยว

    // Clouds for background
    type Cloud = { x: number; y: number; size: number; speed: number };
    const clouds: Cloud[] = [];
    for (let i = 0; i < 6; i++) {
      clouds.push({
        x: Math.random() * width,
        y: Math.random() * (height / 2),
        size: 30 + Math.random() * 40,
        speed: 0.5 + Math.random() * 0.5,
      });
    }

    // Physics
    let birdY = height / 2;
    let birdV = 0;
    const gravity = 0.3;
    const jump = -7;
    let birdRotation = 0;

    // Pipes
    type Pipe = { x: number; gapY: number; scored: boolean };
    const pipes: Pipe[] = [];
    const pipeWidth = 60;
    const pipeGap = 140;
    const pipeSpeed = 1.8;
    let frame = 0;

    let animationId: number;
    const gameOverRef = { current: false };

    const reset = () => {
      birdY = height / 2;
      birdV = 0;
      birdRotation = 0;
      pipes.length = 0;
      frame = 0;
      gameOverRef.current = false;
      setGameOver(false);
    };

    type Mountain = { x: number; height: number; speed: number };
    const mountains: Mountain[] = [];
    for (let i = 0; i < 4; i++) {
      mountains.push({
        x: Math.random() * width,
        height: 100 + Math.random() * 100,
        speed: 0.2 + Math.random() * 0.3,
      });
    }

    // ระบบดาว (เพิ่มความน่าสนใจ)
    const stars = Array.from({ length: 50 }, () => ({
      x: Math.random() * width,
      y: Math.random() * (height / 2),
      size: Math.random() * 2,
      alpha: Math.random() * 0.5 + 0.5,
    }));

    // Draw background gradient, moving clouds
    const drawBackground = () => {
      // Gradient ท้องฟ้า
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, colors.skyTop);
      grad.addColorStop(1, colors.skyBottom);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // วาดดาว
      stars.forEach((star) => {
        ctx.fillStyle = `rgba(255,255,255,${star.alpha})`;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fill();
      });

      // วาดภูเขา
      mountains.forEach((m) => {
        ctx.fillStyle = colors.mountain;
        ctx.beginPath();
        ctx.moveTo(m.x - 100, height - 40);
        ctx.lineTo(m.x, height - 40 - m.height);
        ctx.lineTo(m.x + 100, height - 40);
        ctx.fill();
        m.x -= m.speed;
        if (m.x < -100) m.x = width + 100;
      });

      // เมฆแบบใหม่
      clouds.forEach((c) => {
        c.x -= c.speed;
        if (c.x + c.size < 0) c.x = width;

        // เอฟเฟกต์เมฆ 3D
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, c.size, c.size / 2, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = colors.cloudHighlight;
        ctx.beginPath();
        ctx.ellipse(
          c.x - 10,
          c.y - 5,
          c.size * 0.7,
          c.size / 3,
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();
      });

      // พื้นดินแบบมี texture
      ctx.fillStyle = colors.ground;
      ctx.fillRect(0, height - 40, width, 40);

      // เพิ่มรายละเอียดหญ้า
      ctx.fillStyle = "#3d8b5a";
      for (let i = 0; i < 20; i++) {
        const x = Math.random() * width;
        ctx.beginPath();
        ctx.moveTo(x, height - 40);
        ctx.lineTo(x + 5, height - 50);
        ctx.lineTo(x - 5, height - 50);
        ctx.fill();
      }
    };

    // Draw character (face + wing)
    const drawCharacter = () => {
      const wingFlap = Math.sin(frame * 0.1) * 10;
      ctx.save();
      ctx.translate(50, birdY);
      ctx.rotate((birdRotation * Math.PI) / 180);

      // วาดปีกก่อนตัวละคร
      if (wingImg.complete) {
        // ปีกซ้าย
        ctx.save();
        ctx.translate(-24, 0 + wingFlap);
        ctx.rotate(Math.sin(frame * 0.2) * 0.5);
        ctx.drawImage(wingImg, -24, -16, 48, 32);
        ctx.restore();
      }

      // วาดตัวละครทับปีก (ลำดับหลัง)
      if (charImg.complete) {
        ctx.drawImage(charImg, -16, -16, 32, 32);
      }

      ctx.restore();
    };

    // Draw pipes
    const drawPipe = (x: number, y: number, h: number) => {
      // สร้าง gradient สำหรับท่อ
      const pipeGrad = ctx.createLinearGradient(x, y, x + pipeWidth, y);
      pipeGrad.addColorStop(0, colors.pipe);
      pipeGrad.addColorStop(1, colors.pipeHighlight);

      ctx.fillStyle = pipeGrad;
      ctx.fillRect(x, y, pipeWidth, h);

      // เอฟเฟกต์แสงด้านบน
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.fillRect(x + 2, y + 2, pipeWidth - 4, 6);

      // เอฟเฟกต์ขอบท่อ
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, pipeWidth, h);
    };

    const loop = () => {
      if (gameOverRef.current) return;

      // physics
      birdV += gravity;
      birdY += birdV;
      birdRotation = Math.min(30, Math.max(-30, (birdV / 10) * 30));

      // spawn pipes
      if (frame % 120 === 0) {
        const gapY = Math.random() * (height - pipeGap - 100) + 50;
        pipes.push({ x: width, gapY, scored: false });
      }

      // move pipes & scoring
      pipes.forEach((p) => {
        p.x -= pipeSpeed;
        if (!p.scored && p.x + pipeWidth < 50) {
          onScoreUp();
          p.scored = true;
        }
      });
      if (pipes.length && pipes[0].x + pipeWidth < 0) pipes.shift();

      // render
      drawBackground();
      pipes.forEach((p) => {
        drawPipe(p.x, 0, p.gapY);
        drawPipe(p.x, p.gapY + pipeGap, height - (p.gapY + pipeGap));
      });
      drawCharacter();

      // score
      ctx.fillStyle = colors.scoreText;
      ctx.font = "bold 24px Arial";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 2;
      ctx.strokeText(`Score: ${scoreRef.current}`, 10, 30);
      ctx.fillText(`Score: ${scoreRef.current}`, 10, 30);

      // collision
      const r = 16;
      const hitPipe = pipes.some(
        (p) =>
          50 + r > p.x &&
          50 - r < p.x + pipeWidth &&
          (birdY - r < p.gapY || birdY + r > p.gapY + pipeGap)
      );
      if (birdY - r < 0 || birdY + r > height - 40 || hitPipe) {
        gameOverRef.current = true;
        setGameOver(true);
        // ในส่วนวาดคะแนนเปลี่ยนเป็น
        ctx.font = "bold 26px 'Arial Rounded MT Bold'";
        ctx.fillStyle = "#FFD700";
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 3;
        ctx.strokeText(`⭐ ${scoreRef.current}`, 20, 40);
        ctx.fillText(`⭐ ${scoreRef.current}`, 20, 40);
        return;
      }

      frame++;
      animationId = requestAnimationFrame(loop);
    };

    // start
    reset();
    loop();
    type Particle = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
    };
    const particles: Particle[] = [];
    const jumpAction = () => {
      if (!gameOverRef.current) {
        birdV = jump;
        // สร้าง particles
        for (let i = 0; i < 10; i++) {
          particles.push({
            x: 50,
            y: birdY,
            vx: (Math.random() - 0.5) * 3,
            vy: (Math.random() - 0.5) * 3,
            life: 30,
          });
          particles.forEach((p, i) => {
            p.x += p.vx;
            p.y += p.vy;
            p.life--;

            ctx.fillStyle = `rgba(255,216,0,${p.life / 30})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
            ctx.fill();

            if (p.life <= 0) particles.splice(i, 1);
          });
        }
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") jumpAction();
    };
    const onClick = () => jumpAction();
    window.addEventListener("keydown", onKey);
    canvas.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("keydown", onKey);
      canvas.removeEventListener("click", onClick);
    };
  }, [restartCount]);

  const handleRestart = () => setRestartCount((c) => c + 1);

  return (
    <div className="mx-auto mb-6 text-center">
      <canvas
        ref={canvasRef}
        className="block mx-auto rounded-lg shadow-lg border-4 border-white"
        style={{ background: "transparent" }}
      />
      <p className="text-green-900 mt-2 text-lg font-semibold">
        เล่นให้ได้ 5 แต้มเพื่อปลดล็อคการล็อกอิน
      </p>
      {gameOver && (
        <button
          onClick={handleRestart}
          className="mt-4 px-6 py-3 bg-red-500 text-white rounded-xl font-bold hover:bg-red-600 transition-all transform hover:scale-105 shadow-md"
        >
          เริ่มเกมใหม่!
        </button>
      )}
    </div>
  );
};

export default FlappyBirdGame;
