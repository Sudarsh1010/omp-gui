import ReactDOM from "react-dom/client";
import App from "./App";

// No StrictMode: its double-effect would auto-run the round-trip twice and
// race two omp subprocess handshakes over the shared Tauri event channel.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
