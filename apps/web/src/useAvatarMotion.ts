import { useEffect, useRef } from "react";

export type AvatarActivity = "idle" | "working" | "error";

// Sample a periodic curve so every track keeps its velocity across the loop seam.
const workingCycle = Array.from({ length: 65 }, (_, index) => {
  const offset = index / 64;
  const phase = index === 64 ? 0 : offset * Math.PI * 2;
  const nod = Math.cos(phase * 2);
  const glance = Math.sin(phase);
  const blink = Math.max(0, Math.cos(phase - Math.PI / 2)) ** 32;

  return {
    offset,
    body: `translate3d(0, ${(0.6 * nod).toFixed(4)}px, 0)`,
    face: `translate(${(1.8 * glance).toFixed(4)}px, ${(0.7 + 0.5 * nod).toFixed(4)}px)`,
    eyes: `scaleY(${(0.85 - 0.75 * blink).toFixed(4)})`,
  };
});

const motions = {
  greet: [
    { transform: "translateY(0) scale(1)" },
    { transform: "translateY(2px) scale(1.1, 0.9)", offset: 0.18 },
    { transform: "translateY(-3px) scale(0.95, 1.05)", offset: 0.4 },
    { transform: "translateY(0) scale(1.04, 0.96)", offset: 0.62 },
    { transform: "translateY(-1px) scale(0.99, 1.01)", offset: 0.8 },
    { transform: "translateY(0) scale(1)" },
  ],
  working: workingCycle.map(({ offset, body }) => ({
    offset,
    transform: body,
  })),
  complete: [
    { transform: "translateY(0) scale(1)" },
    { transform: "translateY(2px) scale(1.09, 0.9)", offset: 0.2 },
    { transform: "translateY(-4px) scale(0.94, 1.06)", offset: 0.45 },
    { transform: "translateY(1px) scale(1.06, 0.94)", offset: 0.7 },
    { transform: "translateY(-1px) scale(0.99, 1.01)", offset: 0.85 },
    { transform: "translateY(0) scale(1)" },
  ],
  error: [
    { transform: "translateX(0) scale(1) rotate(0deg)" },
    {
      transform: "translateX(-2px) scale(1.03, 0.97) rotate(-5deg)",
      offset: 0.2,
    },
    {
      transform: "translateX(2px) scale(1.03, 0.97) rotate(5deg)",
      offset: 0.4,
    },
    { transform: "translateX(-1px) scale(1) rotate(-3deg)", offset: 0.6 },
    { transform: "translateX(1px) scale(1) rotate(2deg)", offset: 0.8 },
    { transform: "translateX(0) scale(1) rotate(0deg)" },
  ],
  blink: [
    { transform: "scaleY(1)" },
    { transform: "scaleY(0.1)", offset: 0.45 },
    { transform: "scaleY(1)" },
  ],
};

type Reaction = Exclude<keyof typeof motions, "blink">;

const faceMotions: Record<Reaction, Keyframe[]> = {
  greet: [
    { transform: "translate(0, 0)" },
    { transform: "translate(-1px, 1px)", offset: 0.2 },
    { transform: "translate(2px, -1px)", offset: 0.5 },
    { transform: "translate(0, 0)" },
  ],
  working: workingCycle.map(({ offset, face }) => ({
    offset,
    transform: face,
  })),
  complete: [
    { transform: "translateY(0)" },
    { transform: "translateY(1px)", offset: 0.2 },
    { transform: "translateY(-2px)", offset: 0.45 },
    { transform: "translateY(0)" },
  ],
  error: [
    { transform: "translateY(0)" },
    { transform: "translateY(-1.5px)", offset: 0.2 },
    { transform: "translateY(-1.5px)", offset: 0.6 },
    { transform: "translateY(0)" },
  ],
};

const eyeMotions: Record<Reaction, Keyframe[]> = {
  greet: [
    { transform: "scaleY(1)" },
    { transform: "scaleY(0.1)", offset: 0.2 },
    { transform: "scaleY(1.1)", offset: 0.4 },
    { transform: "scaleY(1)" },
  ],
  working: workingCycle.map(({ offset, eyes }) => ({
    offset,
    transform: eyes,
  })),
  complete: [
    { transform: "scaleY(1)" },
    { transform: "scaleY(0.45)", offset: 0.2 },
    { transform: "scaleY(0.45)", offset: 0.7 },
    { transform: "scaleY(1)" },
  ],
  error: [
    { transform: "scale(1)" },
    { transform: "scale(1.15, 1.25)", offset: 0.2 },
    { transform: "scale(1.15, 1.25)", offset: 0.6 },
    { transform: "scale(1)" },
  ],
};

export function useAvatarMotion(
  activity: AvatarActivity,
  appearance: string,
  enabled: boolean,
) {
  const ref = useRef<SVGSVGElement>(null);
  const previous = useRef(activity);

  useEffect(() => {
    const prior = previous.current;
    previous.current = activity;
    const root = ref.current;

    if (!root || !enabled) {
      return;
    }

    const body = root;
    const face = root.querySelector<SVGGElement>(".agent-avatar-face");
    const interaction = root.closest(".sidebar-agent-row") ?? root;
    const eyes = root.querySelector<SVGGElement>(".agent-avatar-eyes");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const animations = new Set<Animation>();
    let blinkTimer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    let active = false;
    let first = true;
    let lastGreeting = -Infinity;

    function play(
      target: SVGGraphicsElement | null,
      frames: Keyframe[],
      duration: number,
      iterations = 1,
    ) {
      if (!target) {
        return;
      }

      for (const animation of animations) {
        if (
          animation.effect instanceof KeyframeEffect &&
          animation.effect.target === target
        ) {
          animation.cancel();
          animations.delete(animation);
        }
      }

      const animation = target.animate(frames, {
        duration,
        iterations,
        easing: iterations === Infinity ? "linear" : "ease-in-out",
      });
      animations.add(animation);
      void animation.finished.then(
        () => animations.delete(animation),
        () => animations.delete(animation),
      );
    }

    function playReaction(motion: Reaction, duration: number, iterations = 1) {
      play(body, motions[motion], duration, iterations);
      play(face, faceMotions[motion], duration, iterations);
      play(eyes, eyeMotions[motion], duration, iterations);
    }

    function blink() {
      blinkTimer = setTimeout(
        () => {
          play(eyes, motions.blink, 180);
          blink();
        },
        5000 + Math.random() * 7000,
      );
    }

    function stop() {
      clearTimeout(blinkTimer);

      for (const animation of animations) {
        animation.cancel();
      }

      animations.clear();
    }

    function sync() {
      const next = visible && !document.hidden && !reduced.matches;

      if (next === active) {
        return;
      }

      active = next;
      stop();

      if (!active) {
        return;
      }

      if (activity === "working") {
        playReaction("working", 3200, Infinity);
      } else {
        blink();
      }

      if (activity !== "working" && first) {
        const motion =
          activity === "error"
            ? "error"
            : prior === "working"
              ? "complete"
              : "greet";
        playReaction(motion, 850);
      }

      first = false;
    }

    function greet(event: Event) {
      if (
        !active ||
        activity !== "idle" ||
        performance.now() - lastGreeting < 1200 ||
        (event instanceof FocusEvent &&
          event.relatedTarget instanceof Node &&
          interaction.contains(event.relatedTarget))
      ) {
        return;
      }

      lastGreeting = performance.now();
      playReaction("greet", 1000);
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    observer.observe(root);
    interaction.addEventListener("pointerenter", greet);
    interaction.addEventListener("focusin", greet);
    document.addEventListener("visibilitychange", sync);
    reduced.addEventListener("change", sync);

    return () => {
      observer.disconnect();
      interaction.removeEventListener("pointerenter", greet);
      interaction.removeEventListener("focusin", greet);
      document.removeEventListener("visibilitychange", sync);
      reduced.removeEventListener("change", sync);
      stop();
    };
  }, [activity, appearance, enabled]);

  return ref;
}
