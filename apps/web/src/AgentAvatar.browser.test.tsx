import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../test/render.tsx";
import { AgentAvatar } from "./AgentAvatar.tsx";
import type { AvatarActivity } from "./useAvatarMotion.ts";

const avatar = { animal: "cat", color: "blue" } as const;

function avatarElement() {
  const element = document.querySelector<SVGSVGElement>(".agent-avatar");

  if (!element) {
    throw new Error("Missing avatar");
  }

  return element;
}

function bodyAnimations() {
  return avatarElement().getAnimations();
}

function MotionControls() {
  const [activity, setActivity] = useState<AvatarActivity>("idle");

  return (
    <>
      <AgentAvatar avatar={avatar} activity={activity} size={64} />
      <button onClick={() => setActivity("working")}>Work</button>
      <button onClick={() => setActivity("idle")}>Complete</button>
      <button onClick={() => setActivity("error")}>Fail</button>
    </>
  );
}

it("loops working motion until completion or failure", async () => {
  await using _screen = await render(<MotionControls />);
  await page.getByRole("button", { name: "Work", exact: true }).click();
  await expect
    .poll(() => bodyAnimations()[0]?.effect?.getTiming().iterations)
    .toBe(Infinity);
  const tracks = avatarElement().getAnimations({ subtree: true });
  expect(tracks).toHaveLength(3);
  expect(
    new Set(tracks.map((track) => track.effect?.getTiming().duration)).size,
  ).toBe(1);
  expect(new Set(tracks.map((track) => track.startTime)).size).toBe(1);
  expect(
    tracks.every(
      (track) => track.effect?.getComputedTiming().endTime === Infinity,
    ),
  ).toBe(true);
  const face = avatarElement().querySelector(".agent-avatar-face")!;
  const scan = face.getAnimations()[0]!;
  const duration = scan.effect?.getTiming().duration;

  if (typeof duration !== "number") {
    throw new Error("Expected a timed working cycle");
  }

  scan.pause();

  function scanPosition(time: number) {
    scan.currentTime = time;

    return new DOMMatrixReadOnly(getComputedStyle(face).transform).m41;
  }

  const before = scanPosition(duration - 16);
  const seam = scanPosition(duration);
  const after = scanPosition(duration + 16);
  expect(seam - before).toBeGreaterThan(0.03);
  expect(after - seam).toBeCloseTo(seam - before, 3);

  const working = bodyAnimations()[0]!;
  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect.poll(() => bodyAnimations().length).toBe(1);
  expect(working.playState).toBe("idle");
  const completion = bodyAnimations()[0]!;
  expect(completion.effect?.getTiming().iterations).toBe(1);
  expect(
    completion.effect instanceof KeyframeEffect &&
      completion.effect
        .getKeyframes()
        .some((frame) => String(frame.transform).includes("scale")),
  ).toBe(true);
  await page.getByRole("button", { name: "Fail", exact: true }).click();
  await expect.poll(() => bodyAnimations().length).toBe(1);
  const failure = bodyAnimations()[0]!;
  expect(completion.playState).toBe("idle");
  expect(
    failure.effect instanceof KeyframeEffect &&
      failure.effect
        .getKeyframes()
        .some((frame) => String(frame.transform).includes("translateX")),
  ).toBe(true);
});

it("cancels motion while the page is hidden and on unmount", async () => {
  let hidden = false;
  const visibility = vi
    .spyOn(document, "hidden", "get")
    .mockImplementation(() => hidden);

  try {
    let running: Animation;

    {
      await using _screen = await render(
        <AgentAvatar avatar={avatar} activity="working" />,
      );
      await expect.poll(() => bodyAnimations().length).toBe(1);
      const initial = bodyAnimations()[0]!;
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(initial.playState).toBe("idle");
      expect(avatarElement().getAnimations({ subtree: true })).toHaveLength(0);
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      await expect.poll(() => bodyAnimations().length).toBe(1);
      running = bodyAnimations()[0]!;
    }

    expect(running.playState).toBe("idle");
  } finally {
    visibility.mockRestore();
  }
});

it("keeps avatars static for reduced motion and picker thumbnails", async () => {
  const matchMedia = window.matchMedia.bind(window);
  const media = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) =>
      matchMedia(
        query === "(prefers-reduced-motion: reduce)"
          ? "(min-width: 0px)"
          : query,
      ),
    );
  const animate = vi.spyOn(Element.prototype, "animate");

  try {
    await using _screen = await render(
      <>
        <AgentAvatar avatar={avatar} activity="working" />
        <AgentAvatar avatar={avatar} animated={false} />
      </>,
    );
    // Allow the intersection observer to report visibility before checking motion.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(animate).not.toHaveBeenCalled();
    expect(avatarElement().getAnimations({ subtree: true })).toHaveLength(0);
  } finally {
    animate.mockRestore();
    media.mockRestore();
  }
});

it("greets on row hover and keyboard focus with coordinated facial motion", async () => {
  const time = vi.spyOn(performance, "now").mockReturnValue(0);

  try {
    await using _screen = await render(
      <>
        <div className="sidebar-agent-row">
          <button>
            <AgentAvatar avatar={avatar} size={64} />
            Visit agent
          </button>
        </div>
        <button>Away</button>
      </>,
    );
    await expect.poll(() => bodyAnimations().length).toBe(1);
    await page.getByRole("button", { name: "Away", exact: true }).hover();

    for (const animation of avatarElement().getAnimations({ subtree: true })) {
      animation.finish();
    }

    const target = page.getByRole("button", { name: "Visit agent" });
    await target.hover();
    const greeting = avatarElement().getAnimations({ subtree: true });
    expect(greeting).toHaveLength(3);
    expect(
      greeting.every(
        (animation) => animation.effect?.getTiming().iterations === 1,
      ),
    ).toBe(true);
    expect(avatarElement().getAnimations()).toHaveLength(1);
    const body = bodyAnimations()[0]!;
    expect(
      body.effect instanceof KeyframeEffect &&
        body.effect
          .getKeyframes()
          .every((frame) => !String(frame.transform).includes("rotate")),
    ).toBe(true);

    for (const animation of greeting) {
      animation.finish();
    }

    time.mockReturnValue(2000);
    target.element().focus();
    expect(avatarElement().getAnimations({ subtree: true })).toHaveLength(3);
  } finally {
    time.mockRestore();
  }
});

it("keeps the working silhouette at a stable scale throughout the cycle", async () => {
  await using _screen = await render(
    <AgentAvatar avatar={avatar} activity="working" size={32} />,
  );
  await expect.poll(() => bodyAnimations().length).toBe(1);
  const animation = bodyAnimations()[0]!;
  const effect = animation.effect;

  if (!(effect instanceof KeyframeEffect) || !effect.target) {
    throw new Error("Expected an animated head");
  }

  animation.pause();
  const scales: number[] = [];

  for (let frame = 0; frame <= 32; frame++) {
    animation.currentTime = frame * 100;
    const matrix = new DOMMatrixReadOnly(
      getComputedStyle(effect.target).transform,
    );
    scales.push(matrix.a, matrix.d);
  }

  expect(Math.max(...scales) - Math.min(...scales)).toBeLessThan(0.001);
});
