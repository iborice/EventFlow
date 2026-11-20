"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { ApiError, apiRequest } from "@/lib/organizations";
import type { DashboardEvent, Organization } from "@/lib/organizations";
import { OperationsShell } from "./operations-shell";
import type {
  CheckInResult,
  CheckInTicket,
} from "@/lib/event-operations";

type Barcode = { rawValue: string };
type BarcodeDetectorLike = {
  detect: (source: HTMLVideoElement) => Promise<Barcode[]>;
};
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;
type WindowWithBarcodeDetector = Window & {
  BarcodeDetector?: BarcodeDetectorConstructor;
};
type CameraDevices = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function CheckInOperations({
  initialEventId,
  initialOrganization,
}: {
  initialEventId?: string;
  initialOrganization?: string;
}) {
  return (
    <OperationsShell
      description="Check in attendees with a camera, a USB scanner, or an offline-ready ticket list."
      initialEventId={initialEventId}
      initialOrganization={initialOrganization}
      mode="check-in"
      title="Check-in"
    >
      {({ event, organization }) =>
        event ? (
          <CheckIn
            event={event}
            key={`${organization.id}-${event.id}`}
            organization={organization}
          />
        ) : null
      }
    </OperationsShell>
  );
}

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getOnlineSnapshot() {
  return navigator.onLine;
}

function getServerOnlineSnapshot() {
  return true;
}

export function CheckIn({
  organization,
  event,
}: {
  organization: Organization;
  event: DashboardEvent;
}) {
  const [query, setQuery] = useState("");
  const [tickets, setTickets] = useState<CheckInTicket[]>([]);
  const [queuedIds, setQueuedIds] = useState<string[]>([]);
  const [results, setResults] = useState<CheckInResult[]>([]);
  const [cameraActive, setCameraActive] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [queueReady, setQueueReady] = useState(false);
  const online = useSyncExternalStore(
    subscribeOnline,
    getOnlineSnapshot,
    getServerOnlineSnapshot,
  );
  const path =
    `/organizations/${encodeURIComponent(organization.slug)}/events/${event.id}`;
  const queueKey = `eventflow-check-in:${organization.slug}:${event.id}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanBusy = useRef(false);
  const syncBusy = useRef(false);
  const queuedRef = useRef<string[]>([]);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const cameraLastValue = useRef("");

  const latestStatus = useMemo(() => {
    const result = results[0];
    if (!result) return null;
    if (result.status === "invalid") {
      return { title: "Ticket not recognized", tone: "invalid" as const, result };
    }
    if (result.status === "already_checked_in") {
      return { title: "Already checked in", tone: "warning" as const, result };
    }
    return { title: "Check-in complete", tone: "success" as const, result };
  }, [results]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        const saved = localStorage.getItem(queueKey);
        if (saved) {
          const ids: unknown = JSON.parse(saved);
          if (
            !Array.isArray(ids) ||
            ids.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
          ) {
            throw new Error("Stored ticket IDs are invalid.");
          }
          queuedRef.current = ids;
          setQueuedIds(ids);
        }
      } catch {
        setError("The saved offline check-in queue could not be read. Clear site storage before scanning offline.");
      } finally {
        setQueueReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [queueKey]);

  useEffect(() => {
    if (!queueReady) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      const params = new URLSearchParams({ q: query.trim() });
      apiRequest<{ tickets: CheckInTicket[]; total: number }>(
        `${path}/check-in/search?${params.toString()}`,
      )
        .then((response) => {
          if (active) setTickets(response.tickets);
        })
        .catch((caught: unknown) => {
          if (active) setError(messageFor(caught));
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [path, query, queueReady]);

  const syncQueuedTickets = useCallback(async () => {
    if (syncBusy.current || !navigator.onLine || queuedRef.current.length === 0) return;
    syncBusy.current = true;
    setSyncing(true);
    setError("");
    const accumulated: CheckInResult[] = [];
    try {
      while (queuedRef.current.length > 0) {
        const batch = queuedRef.current.slice(0, 200);
        const response = await apiRequest<{ results: CheckInResult[] }>(
          `${path}/check-in/sync`,
          {
            method: "POST",
            body: JSON.stringify({ ticket_ids: batch }),
          },
        );
        accumulated.push(...response.results);
        const processed = new Set(response.results.map((result) => result.ticket_id));
        if (processed.size !== batch.length) {
          throw new Error("The server did not acknowledge every offline scan. The remaining queue was kept.");
        }
        const remaining = queuedRef.current.filter((id) => !processed.has(id));
        queuedRef.current = remaining;
        setQueuedIds(remaining);
        localStorage.setItem(queueKey, JSON.stringify(remaining));
      }
      if (accumulated.length) {
        setResults(accumulated.slice(-20).reverse());
        setMessage(`${accumulated.length} offline scan${accumulated.length === 1 ? "" : "s"} synchronized.`);
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      syncBusy.current = false;
      setSyncing(false);
    }
  }, [path, queueKey]);

  useEffect(() => {
    const onOnline = () => void syncQueuedTickets();
    window.addEventListener("online", onOnline);
    if (queueReady && navigator.onLine) void syncQueuedTickets();
    return () => window.removeEventListener("online", onOnline);
  }, [queueReady, syncQueuedTickets]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const refreshSearch = useCallback(async () => {
    try {
      const params = new URLSearchParams({ q: query.trim() });
      const response = await apiRequest<{ tickets: CheckInTicket[]; total: number }>(
        `${path}/check-in/search?${params.toString()}`,
      );
      setTickets(response.tickets);
    } catch (caught) {
      setError(messageFor(caught));
    }
  }, [path, query]);

  const storeOffline = useCallback((ids: string[]) => {
    const validIds = ids.filter((id) => UUID_PATTERN.test(id));
    if (validIds.length !== ids.length) {
      setError("The scanned code is not a valid ticket ID.");
      return;
    }
    const next = Array.from(new Set([...queuedRef.current, ...validIds]));
    queuedRef.current = next;
    setQueuedIds(next);
    try {
      localStorage.setItem(queueKey, JSON.stringify(next));
    } catch {
      setError("This device could not save the offline queue. Keep this page open and reconnect before leaving.");
      return;
    }
    setResults([]);
    setMessage(`${validIds.length} scan${validIds.length === 1 ? "" : "s"} queued on this device. It will sync when online.`);
  }, [queueKey]);

  const submitTicketIds = useCallback(async (ids: string[]) => {
    const cleanIds = Array.from(new Set(ids.map((id) => id.trim())));
    if (!cleanIds.length) return;
    if (cleanIds.some((id) => !UUID_PATTERN.test(id))) {
      setError("The scanned code is not a valid ticket ID.");
      return;
    }
    if (!navigator.onLine) {
      setError("");
      storeOffline(cleanIds);
      return;
    }
    setError("");
    setMessage("");
    try {
      const response = await apiRequest<{ results: CheckInResult[] }>(
        `${path}/check-in/sync`,
        {
          method: "POST",
          body: JSON.stringify({ ticket_ids: cleanIds }),
        },
      );
      setResults(response.results.reverse());
      setMessage("");
      void refreshSearch();
      inputRef.current?.focus();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(messageFor(caught));
      } else {
        storeOffline(cleanIds);
      }
    }
  }, [path, refreshSearch, storeOffline]);

  useEffect(() => {
    if (!cameraActive) return;
    const Detector = (window as WindowWithBarcodeDetector).BarcodeDetector;
    if (!Detector || !videoRef.current) return;
    let interval = 0;
    let active = true;
    const stream = streamRef.current;
    videoRef.current.srcObject = stream;
    void videoRef.current.play().catch(() => {
      if (active) setError("The camera preview could not start. Check camera permissions.");
    });
    detectorRef.current = new Detector({ formats: ["qr_code"] });
    interval = window.setInterval(async () => {
      const video = videoRef.current;
      const detector = detectorRef.current;
      if (!active || !video || !detector || video.readyState < 2 || scanBusy.current) return;
      scanBusy.current = true;
      try {
        const detected = await detector.detect(video);
        const value = detected[0]?.rawValue.trim();
        if (value && value !== cameraLastValue.current) {
          cameraLastValue.current = value;
          await submitTicketIds([value]);
        } else if (!value) {
          cameraLastValue.current = "";
        }
      } catch {
        setError("The QR code could not be read. Use the scanner field instead.");
      } finally {
        scanBusy.current = false;
      }
    }, 350);
    return () => {
      active = false;
      window.clearInterval(interval);
      detectorRef.current = null;
    };
  }, [cameraActive, submitTicketIds]);

  async function startCamera() {
    setError("");
    const detector = (window as WindowWithBarcodeDetector).BarcodeDetector;
    const devices = Reflect.get(navigator, "mediaDevices") as
      | CameraDevices
      | undefined;
    if (
      typeof devices?.getUserMedia !== "function" ||
      !detector
    ) {
      setError("QR camera scanning is not supported in this browser. Use a USB scanner or enter the ticket ID.");
      return;
    }
    try {
      streamRef.current = await devices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      setCameraActive(true);
    } catch {
      setError("Camera access was denied or unavailable. Use a USB scanner or enter the ticket ID.");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
  }

  async function handleManualScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = inputRef.current;
    if (!input?.value.trim()) return;
    const value = input.value.trim();
    input.value = "";
    await submitTicketIds([value]);
  }

  return (
    <section className="check-in">
      <div className="check-in-main">
        <div className="operations-panel-heading">
          <div><span>ENTRY CONTROL</span><strong>Scan a ticket</strong></div>
          <span className={online ? "connection-status is-online" : "connection-status is-offline"}>
            <i />{online ? "Online" : "Offline"}
          </span>
        </div>
        <form className="check-in-scanner" onSubmit={handleManualScan}>
          <label htmlFor="ticket-code">Scan QR or enter ticket ID</label>
          <div>
            <input
              autoComplete="off"
              autoFocus
              id="ticket-code"
              inputMode="text"
              placeholder="Ticket UUID"
              ref={inputRef}
            />
            <button className="button button-primary" type="submit">Check in</button>
          </div>
          <small>A USB barcode scanner works as keyboard input. Scans are safe to queue offline.</small>
        </form>

        <div className="check-in-camera">
          {cameraActive ? (
            <>
              <video aria-label="QR ticket camera preview" autoPlay playsInline ref={videoRef} />
              <button className="button button-quiet" onClick={stopCamera} type="button">Stop camera</button>
            </>
          ) : (
            <button
              className="check-in-camera-button"
              onClick={startCamera}
              type="button"
            >
              <span aria-hidden="true">⌗</span>
              <strong>Use camera to scan QR</strong>
              <small>Uses this device’s rear camera where supported</small>
            </button>
          )}
        </div>
        {error && <p className="operations-alert" role="alert">{error}</p>}
        {message && <p className="operations-notice" role="status">{message}</p>}
        {latestStatus && (
          <div className={`check-in-result is-${latestStatus.tone}`} role="status">
            <span>{latestStatus.title}</span>
            <strong>{latestStatus.result.attendee_name ?? latestStatus.result.ticket_id}</strong>
            <small>
              {latestStatus.result.ticket_name ?? "Unknown ticket"}
              {latestStatus.result.seat_label ? ` · Seat ${latestStatus.result.seat_label}` : ""}
            </small>
          </div>
        )}
      </div>

      <aside className="check-in-attendees">
        <div className="operations-panel-heading">
          <div><span>ATTENDEES</span><strong>Find a ticket</strong></div>
          {queuedIds.length > 0 && (
            <button className="button button-quiet check-in-sync" disabled={syncing || !online} onClick={() => void syncQueuedTickets()} type="button">
              {syncing ? "Syncing…" : `Sync ${queuedIds.length}`}
            </button>
          )}
        </div>
        <label className="check-in-search">
          <span className="sr-only">Search attendees or ticket ID</span>
          <input
            onChange={(change) => setQuery(change.target.value)}
            placeholder="Name, email, or ticket ID"
            value={query}
          />
        </label>
        {searching && tickets.length === 0 ? (
          <div className="operations-loading"><span /><span /></div>
        ) : tickets.length ? (
          <div className="check-in-list">
            {tickets.map((ticket) => (
              <article className="check-in-attendee" key={ticket.ticket_id}>
                <div>
                  <strong>{ticket.attendee_name || "Guest"}</strong>
                  <span>{ticket.ticket_name}{ticket.seat_label ? ` · ${ticket.seat_label}` : ""}</span>
                  <small>{ticket.attendee_email}</small>
                </div>
                {ticket.checked_in_at ? (
                  <span className="check-in-checked">Checked in</span>
                ) : (
                  <button
                    className="button button-quiet"
                    onClick={() => void submitTicketIds([ticket.ticket_id])}
                    type="button"
                  >
                    Check in
                  </button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="check-in-list-empty">
            {searching ? "Searching…" : "No matching tickets. Try a name, email, or full ticket ID."}
          </div>
        )}
      </aside>
    </section>
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The check-in service could not be reached.";
}
