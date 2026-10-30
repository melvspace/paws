import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "../Dashboard.tsx";

export const Route = createFileRoute("/")({ component: Dashboard });
