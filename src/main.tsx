import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Import for its side effect: applies the stored light/dark theme to <html>
// before first paint, avoiding a flash of the wrong palette.
import "./store/themeStore";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
