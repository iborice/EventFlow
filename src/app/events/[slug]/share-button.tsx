"use client";

import { Share2 } from "lucide-react";
import { useState } from "react";

export function ShareButton({ title }: { title: string }) {
  const [message, setMessage] = useState("");

  async function shareEvent() {
    try {
      if (navigator.share) {
        await navigator.share({
          title,
          url: window.location.href,
        });
        setMessage("Event shared.");
      } else {
        await navigator.clipboard.writeText(window.location.href);
        setMessage("Event link copied.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("Could not share this event. Copy the page URL to share it.");
    }

    window.setTimeout(() => setMessage(""), 3200);
  }

  return (
    <div className="public-share-wrap">
      <button
        className="public-share"
        onClick={shareEvent}
        type="button"
        aria-label="Share event"
      >
        <Share2 size={17} />
        <span>Share</span>
      </button>
      <span className="share-feedback" role="status">{message}</span>
    </div>
  );
}
