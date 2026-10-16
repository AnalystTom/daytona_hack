import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "./icons";
import "./intro.css";

const seenKey = "reversy:intro-seen:v2";

export function shouldRevealSite(currentTime: number, duration: number) {
  return (
    Number.isFinite(duration) && duration > 2 && currentTime >= duration - 2
  );
}

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
  const [mobile] = useState(
    () =>
      window.matchMedia("(max-width: 600px) and (orientation: portrait)")
        .matches,
  );
  const [state, setState] = useState<
    "ready" | "loading" | "playing" | "leaving"
  >("loading");

  useLayoutEffect(() => {
    let active = true;
    const dialog = dialogRef.current;
    const video = videoRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog?.showModal();
    video?.play().catch(() => {
      if (active) setState("ready");
    });
    return () => {
      active = false;
      video?.pause();
      dialog?.close();
      document.body.style.overflow = overflow;
    };
  }, []);

  useEffect(() => {
    if (state !== "leaving") return;
    const timeout = window.setTimeout(onFinish, 700);
    return () => window.clearTimeout(timeout);
  }, [state, onFinish]);

  function play() {
    setState("loading");
    videoRef.current?.play().catch(onFinish);
  }

  return (
    <dialog
      ref={dialogRef}
      className={`intro${state === "leaving" ? " intro-leaving" : ""}`}
      aria-label="Reversy introduction"
      onCancel={onFinish}
    >
      <video
        ref={videoRef}
        className={`intro-video${mobile ? " intro-video-mobile" : ""}`}
        src={
          mobile
            ? "/intro/reversy-intro-mobile.mp4"
            : "/intro/reversy-intro.mp4"
        }
        poster={
          mobile
            ? "/intro/daytona-poster-mobile.jpg"
            : "/intro/daytona-poster.jpg"
        }
        preload="auto"
        autoPlay
        muted
        playsInline
        disablePictureInPicture
        aria-label="The Reversy beaver cuts through the Daytona page to reveal Reversy"
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          if (shouldRevealSite(video.currentTime, video.duration)) {
            setState("leaving");
          }
        }}
        onEnded={() => setState("leaving")}
        onError={onFinish}
        onWaiting={() =>
          setState((current) => (current === "playing" ? "loading" : current))
        }
        onPlaying={() =>
          setState((current) => (current === "leaving" ? current : "playing"))
        }
      />
      {state === "ready" && (
        <button
          type="button"
          className="intro-trigger"
          aria-label="Play Reversy intro"
          onClick={play}
        >
          <span className="intro-prompt">
            Play intro <Icon name="click" />
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
