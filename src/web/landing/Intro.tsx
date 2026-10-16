import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import "./intro.css";

const seenKey = "reversy:intro-seen";

export function shouldShowIntro() {
  if (typeof window === "undefined") return false;
  if (
    window.location.hash ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return false;
  }
  try {
    return window.sessionStorage.getItem(seenKey) !== "1";
  } catch {
    return false;
  }
}

export function LandingIntro({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(shouldShowIntro);

  function finish() {
    try {
      window.sessionStorage.setItem(seenKey, "1");
    } catch {
      // Storage restrictions must never prevent entering the site.
    }
    setVisible(false);
  }

  return (
    <>
      {children}
      {visible && <Intro onFinish={finish} />}
    </>
  );
}

function Intro({ onFinish }: { onFinish: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"ready" | "loading" | "playing">("ready");

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const video = videoRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog?.showModal();
    return () => {
      video?.pause();
      dialog?.close();
      document.body.style.overflow = overflow;
    };
  }, []);

  function play() {
    setState("loading");
    videoRef.current?.play().catch(onFinish);
  }

  return (
    <dialog
      ref={dialogRef}
      className="intro"
      aria-label="Reversy introduction"
      onCancel={onFinish}
    >
      <video
        ref={videoRef}
        className="intro-video"
        src="/intro/reversy-intro.mp4"
        poster="/intro/daytona-poster.jpg"
        preload="none"
        muted
        playsInline
        disablePictureInPicture
        aria-label="The Reversy beaver cuts through the Daytona page to reveal Reversy"
        onEnded={onFinish}
        onError={onFinish}
        onWaiting={() => setState("loading")}
        onPlaying={() => setState("playing")}
      />
      {state === "ready" && (
        <button
          type="button"
          className="intro-trigger"
          aria-label="Play Reversy intro"
          onClick={play}
        >
          <span className="intro-prompt">
            Click to take it apart <Icon name="click" />
          </span>
        </button>
      )}
      {state === "loading" && (
        <p className="intro-loading" role="status">
          Loading intro…
        </p>
      )}
      <button type="button" className="intro-skip" onClick={onFinish}>
        Skip intro
      </button>
    </dialog>
  );
}
