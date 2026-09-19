import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("OpeningOS root element is missing");

const convexUrl = import.meta.env.VITE_CONVEX_URL;
const root = createRoot(rootElement);

if (typeof convexUrl === "string" && convexUrl.length > 0) {
  const client = new ConvexReactClient(convexUrl);
  root.render(
    <React.StrictMode>
      <ConvexAuthProvider client={client}>
        <App />
      </ConvexAuthProvider>
    </React.StrictMode>,
  );
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
