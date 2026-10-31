import type { ReactNode } from "react";
import "./avatars.css";
import { avatarColors, type AgentAvatar as Avatar } from "@paws/contracts";

const roundHead = (
  <path d="M32 14C28 14 27 15 25 13C23 11 23 6 16 6C8 6 4 13 6 20C8 27 9 25 9 35C9 49 18 58 32 58C46 58 55 49 55 35C55 25 56 27 58 20C60 13 56 6 48 6C41 6 41 11 39 13C37 15 36 14 32 14Z" />
);

const heads: Record<Avatar["animal"], ReactNode> = {
  cat: (
    <path d="M32 16C28 16 26 17 24 16C22 15 18 8 14 8C10 8 10 15 10 21C10 27 8 29 8 35C8 49 18 58 32 58C46 58 56 49 56 35C56 29 54 27 54 21C54 15 54 8 50 8C46 8 42 15 40 16C38 17 36 16 32 16Z" />
  ),
  dog: (
    <path d="M32 14C24 14 22 17 18 17C14 17 11 14 8 18C5 22 3 34 5 42C7 50 13 51 16 46C19 41 18 57 32 57C46 57 45 41 48 46C51 51 57 50 59 42C61 34 59 22 56 18C53 14 50 17 46 17C42 17 40 14 32 14Z" />
  ),
  fox: (
    <>
      <path d="M32 17C28 17 26 18 24 16C22 14 17 7 13 7C9 7 9 15 9 21C9 27 8 29 8 35C8 45 22 58 32 58C42 58 56 45 56 35C56 29 55 27 55 21C55 15 55 7 51 7C47 7 42 14 40 16C38 18 36 17 32 17Z" />
      <path
        d="M32 39C28 39 26 33 21 33C16 33 13 37 13 42C13 49 24 54 32 54C40 54 51 49 51 42C51 37 48 33 43 33C38 33 36 39 32 39Z"
        fill="#fff"
      />
    </>
  ),
  bear: roundHead,
  rabbit: (
    <path d="M32 19C29 19 28 21 27 17C26 13 29 2 21 2C13 2 15 17 14 24C13 31 8 30 8 38C8 50 18 58 32 58C46 58 56 50 56 38C56 30 51 31 50 24C49 17 51 2 43 2C35 2 38 13 37 17C36 21 35 19 32 19Z" />
  ),
  panda: (
    <>
      {roundHead}
      <g fill="#171717">
        <circle cx="16" cy="16" r="6" />
        <circle cx="48" cy="16" r="6" />
        <ellipse cx="23" cy="34" rx="7" ry="8" />
        <ellipse cx="41" cy="34" rx="7" ry="8" />
      </g>
    </>
  ),
  mouse: (
    <path d="M32 23C29 23 28 24 26 21C24 18 29 4 17 4C5 4 3 17 10 23C17 29 12 30 12 37C12 50 21 58 32 58C43 58 52 50 52 37C52 30 47 29 54 23C61 17 59 4 47 4C35 4 40 18 38 21C36 24 35 23 32 23Z" />
  ),
  raccoon: (
    <>
      {roundHead}
      <rect x="13" y="27" width="38" height="14" rx="7" fill="#171717" />
    </>
  ),
};

export function AgentAvatar({
  avatar,
  size = 32,
}: {
  avatar: Avatar;
  size?: number;
}) {
  const masked = avatar.animal === "raccoon" || avatar.animal === "panda";

  return (
    <svg
      className="agent-avatar"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill={avatarColors[avatar.color]}
      aria-hidden="true"
    >
      {heads[avatar.animal]}
      <g fill={masked ? "#fff" : "#171717"}>
        <circle cx="23" cy="34" r="2.5" />
        <circle cx="41" cy="34" r="2.5" />
      </g>
      <ellipse cx="32" cy="44" rx="3" ry="2.5" fill="#171717" />
    </svg>
  );
}
