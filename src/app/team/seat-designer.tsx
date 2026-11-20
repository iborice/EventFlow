"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { apiRequest } from "@/lib/organizations";
import type { DashboardEvent, Organization } from "@/lib/organizations";
import type { SeatingWorkspace } from "@/lib/event-operations";
import { OperationsShell } from "./operations-shell";

type ZoneDraft = SeatingWorkspace["zones"][number];
type SeatDraft = SeatingWorkspace["seats"][number];

export function SeatDesignerOperations({
  initialEventId,
  initialOrganization,
}: {
  initialEventId?: string;
  initialOrganization?: string;
}) {
  return (
    <OperationsShell
      description="Arrange zones, generate rows, and tune every seat before tickets go on sale."
      initialEventId={initialEventId}
      initialOrganization={initialOrganization}
      mode="seating"
      title="Seat designer"
    >
      {({ event, organization }) =>
        event ? (
          <SeatDesigner
            event={event}
            key={`${organization.id}-${event.id}`}
            organization={organization}
          />
        ) : null
      }
    </OperationsShell>
  );
}

export function SeatDesigner({
  organization,
  event,
}: {
  organization: Organization;
  event: DashboardEvent;
}) {
  const [workspace, setWorkspace] = useState<SeatingWorkspace | null>(null);
  const [zones, setZones] = useState<ZoneDraft[]>([]);
  const [seats, setSeats] = useState<SeatDraft[]>([]);
  const [width, setWidth] = useState(1000);
  const [height, setHeight] = useState(640);
  const [activeZoneKey, setActiveZoneKey] = useState("");
  const [zoneName, setZoneName] = useState("");
  const [zoneTicketId, setZoneTicketId] = useState(0);
  const [zoneColor, setZoneColor] = useState("#7167E8");
  const [seatsPerRow, setSeatsPerRow] = useState(10);
  const [scale, setScale] = useState(1);
  const [viewOrigin, setViewOrigin] = useState({ x: 0, y: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const pan = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const eventPath =
    `/organizations/${encodeURIComponent(organization.slug)}/events/${event.id}/seating`;
  const viewWidth = width / scale;
  const viewHeight = height / scale;
  const ticketCounts = useMemo(() => {
    const zoneTickets = new Map(zones.map((zone) => [zone.key, zone.ticket_type_id]));
    const counts = new Map<number, number>();
    for (const seat of seats) {
      const ticketId = zoneTickets.get(seat.zone_key);
      if (ticketId !== undefined) counts.set(ticketId, (counts.get(ticketId) ?? 0) + 1);
    }
    return counts;
  }, [seats, zones]);
  const mapIsValid = Boolean(
    zones.length &&
      seats.length &&
      zones.every((zone) =>
        seats.some((seat) => seat.zone_key === zone.key),
      ) &&
      new Set(seats.map((seat) => seat.label)).size === seats.length &&
      workspace?.ticket_types.every(
        (ticket) => (ticketCounts.get(ticket.id) ?? 0) === ticket.capacity ||
          !zones.some((zone) => zone.ticket_type_id === ticket.id),
      ),
  );
  const activeZone = zones.find((zone) => zone.key === activeZoneKey);

  useEffect(() => {
    let active = true;
    apiRequest<SeatingWorkspace>(eventPath)
      .then((data) => {
        if (!active) return;
        setWorkspace(data);
        setWidth(data.width);
        setHeight(data.height);
        setZones(data.zones);
        setSeats(data.seats);
        setActiveZoneKey(data.zones[0]?.key ?? "");
        setZoneTicketId(data.ticket_types[0]?.id ?? 0);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(messageFor(caught));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [event.id, eventPath]);

  function addZone() {
    const name = zoneName.trim();
    const ticketId = zoneTicketId;
    if (!name || !workspace || !ticketId) {
      setError("Enter a zone name and choose its ticket type.");
      return;
    }
    if (zones.length >= 20) {
      setError("A seat map can contain up to 20 zones.");
      return;
    }
    const keyBase =
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
      "zone";
    let key = keyBase.slice(0, 32);
    let suffix = 2;
    while (zones.some((zone) => zone.key === key)) {
      const ending = `-${suffix}`;
      key = `${keyBase.slice(0, 32 - ending.length)}${ending}`;
      suffix += 1;
    }
    const zone = {
      key,
      name,
      color: zoneColor,
      ticket_type_id: ticketId,
      ticket_name:
        workspace.ticket_types.find((ticket) => ticket.id === ticketId)?.name ??
        "Ticket",
      price:
        workspace.ticket_types.find((ticket) => ticket.id === ticketId)?.price ??
        "0.00",
    };
    setZones((current) => [...current, zone]);
    setActiveZoneKey(zone.key);
    setZoneName("");
    setError("");
  }

  function zoomBy(amount: number) {
    setScale((value) => Math.max(1, Math.min(3, value + amount)));
    setViewOrigin({ x: 0, y: 0 });
  }

  function removeActiveZone() {
    if (!activeZone) return;
    setSeats((current) =>
      current.filter((seat) => seat.zone_key !== activeZone.key),
    );
    setZones((current) => current.filter((zone) => zone.key !== activeZone.key));
    setActiveZoneKey(zones.find((zone) => zone.key !== activeZone.key)?.key ?? "");
  }

  function generateSeats() {
    if (!workspace || !activeZone) {
      setError("Create or select a seating zone first.");
      return;
    }
    const ticket = workspace.ticket_types.find(
      (item) => item.id === activeZone.ticket_type_id,
    );
    if (!ticket) {
      setError("Choose a valid ticket type for this zone.");
      return;
    }
    const alreadyAllocated = zones
      .filter(
        (zone) =>
          zone.ticket_type_id === ticket.id && zone.key !== activeZone.key,
      )
      .reduce(
        (count, zone) =>
          count + seats.filter((seat) => seat.zone_key === zone.key).length,
        0,
      );
    const count = ticket.capacity - alreadyAllocated;
    if (count < 1 || seats.length - seats.filter((seat) => seat.zone_key === activeZone.key).length + count > 3000) {
      setError("This ticket type has no remaining seats to generate.");
      return;
    }

    const columns = Math.max(
      1,
      Math.min(136, Math.max(seatsPerRow, Math.ceil(count / 90))),
    );
    const rows = Math.ceil(count / columns);
    const nextWidth = Math.max(width, Math.min(5000, 120 + (columns - 1) * 38));
    const nextHeight = Math.max(height, Math.min(5000, 120 + rows * 52));
    const spacing = columns > 1
      ? Math.min(58, (nextWidth - 120) / (columns - 1))
      : 0;
    const zoneNumber = zones.findIndex((zone) => zone.key === activeZone.key) + 1;
    const generated: SeatDraft[] = Array.from({ length: count }, (_, index) => {
      const rowIndex = Math.floor(index / columns);
      const number = (index % columns) + 1;
      const rowLabel = rowIndex < 26
        ? String.fromCharCode(65 + rowIndex)
        : `R${rowIndex + 1}`;
      const row = `Z${zoneNumber}${rowLabel}`;
      return {
        id: -(index + 1),
        label: `${row}-${String(number).padStart(2, "0")}`,
        row,
        number,
        x: Math.round(60 + (number - 1) * spacing),
        y: Math.min(nextHeight - 40, 100 + rowIndex * 52),
        zone_key: activeZone.key,
        zone_color: activeZone.color,
        ticket_type_id: ticket.id,
        blocked: false,
        available: true,
      };
    });
    const otherSeats = seats.filter((seat) => seat.zone_key !== activeZone.key);
    setSeats([...otherSeats, ...generated]);
    setWidth(nextWidth);
    setHeight(nextHeight);
    setError("");
    setNotice(`${generated.length} seats generated for ${activeZone.name}.`);
  }

  function startSeatDrag(event: PointerEvent<SVGGElement>, seatId: number) {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: seatId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
  }

  function moveSeat(event: PointerEvent<SVGGElement>) {
    if (!drag.current) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const bounds = svg.getBoundingClientRect();
    const dx = event.clientX - drag.current.startX;
    const dy = event.clientY - drag.current.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
    if (!drag.current.moved) return;
    const x = Math.max(
      12,
      Math.min(
        width - 12,
        Math.round(viewOrigin.x + ((event.clientX - bounds.left) / bounds.width) * viewWidth),
      ),
    );
    const y = Math.max(
      65,
      Math.min(
        height - 12,
        Math.round(viewOrigin.y + ((event.clientY - bounds.top) / bounds.height) * viewHeight),
      ),
    );
    const seatId = drag.current.id;
    setSeats((current) =>
      current.map((seat) => (seat.id === seatId ? { ...seat, x, y } : seat)),
    );
  }

  function finishSeatDrag(event: PointerEvent<SVGGElement>) {
    if (!drag.current) return;
    if (!drag.current.moved) {
      const seatId = drag.current.id;
      setSeats((current) =>
        current.map((seat) =>
          seat.id === seatId ? { ...seat, blocked: !seat.blocked } : seat,
        ),
      );
    }
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function startCanvasPan(event: PointerEvent<SVGSVGElement>) {
    const target = event.target;
    if (
      target !== event.currentTarget &&
      !(target instanceof SVGRectElement && target.classList.contains("seat-map-stage"))
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: viewOrigin.x,
      originY: viewOrigin.y,
    };
  }

  function moveCanvas(event: PointerEvent<SVGSVGElement>) {
    if (!pan.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const deltaX = (event.clientX - pan.current.startX) * (viewWidth / bounds.width);
    const deltaY = (event.clientY - pan.current.startY) * (viewHeight / bounds.height);
    setViewOrigin({
      x: Math.max(0, Math.min(width - viewWidth, Math.round(pan.current.originX - deltaX))),
      y: Math.max(0, Math.min(height - viewHeight, Math.round(pan.current.originY - deltaY))),
    });
  }

  function finishCanvasPan(event: PointerEvent<SVGSVGElement>) {
    if (!pan.current) return;
    pan.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function saveSeatMap() {
    if (!workspace || !mapIsValid || saving) {
      setError("Match each reserved-seat ticket capacity to its seats before saving.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const saved = await apiRequest<SeatingWorkspace>(eventPath, {
        method: "PUT",
        body: JSON.stringify({
          width,
          height,
          zones: zones.map(({ key, name, color, ticket_type_id }) => ({
            key,
            name,
            color,
            ticket_type_id,
          })),
          seats: seats.map(
            ({ label, row, number, x, y, zone_key, blocked }) => ({
              label,
              row,
              number,
              x,
              y,
              zone_key,
              blocked,
            }),
          ),
        }),
      });
      setWorkspace(saved);
      setZones(saved.zones);
      setSeats(saved.seats);
      setNotice("Seat map saved.");
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  }

  if (loading || !workspace) {
    return <div className="operations-loading"><span /><span /><span /></div>;
  }

  return (
    <section className="seat-designer">
      <div className="seat-designer-tools">
        <div className="seat-designer-panel">
          <div className="operations-panel-heading">
            <div><span>LAYOUT</span><strong>Canvas & zones</strong></div>
            <span className="seat-count-pill">{seats.length} / 3,000 seats</span>
          </div>
          <div className="seat-layout-fields">
            <label>
              Canvas width
              <input
                max={5000}
                min={100}
                onChange={(change) => {
                  setWidth(Math.max(100, Math.min(5000, Number(change.target.value) || 100)));
                  setViewOrigin({ x: 0, y: 0 });
                }}
                type="number"
                value={width}
              />
            </label>
            <label>
              Canvas height
              <input
                max={5000}
                min={100}
                onChange={(change) => {
                  setHeight(Math.max(100, Math.min(5000, Number(change.target.value) || 100)));
                  setViewOrigin({ x: 0, y: 0 });
                }}
                type="number"
                value={height}
              />
            </label>
          </div>
          <div className="seat-zone-list">
            {zones.map((zone) => (
              <button
                aria-pressed={activeZoneKey === zone.key}
                className={activeZoneKey === zone.key ? "seat-zone-row is-active" : "seat-zone-row"}
                key={zone.key}
                onClick={() => setActiveZoneKey(zone.key)}
                type="button"
              >
                <i style={{ backgroundColor: zone.color }} />
                <span><strong>{zone.name}</strong><small>{zone.ticket_name}</small></span>
                <b>{seats.filter((seat) => seat.zone_key === zone.key).length}</b>
              </button>
            ))}
          </div>
          <div className="seat-zone-editor">
            <label>
              Zone name
              <input
                maxLength={80}
                onChange={(change) => setZoneName(change.target.value)}
                placeholder="Balcony"
                value={zoneName}
              />
            </label>
            <label>
              Ticket type
              <select
                onChange={(change) => setZoneTicketId(Number(change.target.value))}
                value={zoneTicketId}
              >
                {workspace.ticket_types.map((ticket) => (
                  <option key={ticket.id} value={ticket.id}>
                    {ticket.name} · {ticket.capacity} seats
                  </option>
                ))}
              </select>
            </label>
            <label className="seat-color-field">
              Zone color
              <input
                aria-label="Zone color"
                onChange={(change) => setZoneColor(change.target.value.toUpperCase())}
                type="color"
                value={zoneColor}
              />
            </label>
            <button className="button button-quiet" onClick={addZone} type="button">
              Add zone
            </button>
          </div>
          {activeZone && (
            <div className="seat-generator">
              <label>
                Seats per row
                <input
                  max={999}
                  min={1}
                  onChange={(change) => setSeatsPerRow(Number(change.target.value))}
                  type="number"
                  value={seatsPerRow}
                />
              </label>
              <button className="button button-quiet" onClick={generateSeats} type="button">
                Generate seats for {activeZone.name}
              </button>
              <button className="button button-quiet" onClick={removeActiveZone} type="button">
                Remove zone
              </button>
              <p>Drag seats to reposition. Select a seat to block or unblock it.</p>
            </div>
          )}
          {error && <p className="operations-alert" role="alert">{error}</p>}
          {notice && <p className="operations-notice" role="status">{notice}</p>}
          <button
            className="button button-primary seat-save-button"
            disabled={saving || !mapIsValid}
            onClick={saveSeatMap}
            type="button"
          >
            {saving ? "Saving layout…" : "Save seat map"}
          </button>
        </div>

        <div className="seat-designer-preview">
          <div className="operations-panel-heading">
            <div><span>LIVE PREVIEW</span><strong>{event.title}</strong></div>
            <div className="seat-map-zoom">
              <button aria-label="Zoom out" disabled={scale <= 1} onClick={() => zoomBy(-0.5)} type="button">−</button>
              <span>{Math.round(scale * 100)}%</span>
              <button aria-label="Zoom in" disabled={scale >= 3} onClick={() => zoomBy(0.5)} type="button">+</button>
            </div>
          </div>
          <svg
            aria-label="Seat layout preview"
            className="seat-designer-canvas"
            onPointerDown={startCanvasPan}
            onPointerMove={moveCanvas}
            onPointerUp={finishCanvasPan}
            viewBox={`${viewOrigin.x} ${viewOrigin.y} ${viewWidth} ${viewHeight}`}
          >
            <rect
              className="seat-map-stage"
              height="28"
              rx="9"
              width={width * 0.62}
              x={width * 0.19}
              y="22"
            />
            <text className="seat-map-stage-label" textAnchor="middle" x={width / 2} y="41">STAGE</text>
            {seats.map((seat) => (
              <g
                aria-label={`${seat.label}, ${seat.blocked ? "blocked" : "available"}. Activate to toggle block status.`}
                className={`seat-map-seat seat-map-seat--editor${seat.blocked ? " seat-map-seat--blocked" : ""}`}
                key={`${seat.zone_key}-${seat.label}`}
                onPointerDown={(pointer) => startSeatDrag(pointer, seat.id)}
                onPointerMove={moveSeat}
                onPointerUp={finishSeatDrag}
                onKeyDown={(keyboard) => {
                  if (keyboard.key !== "Enter" && keyboard.key !== " ") return;
                  keyboard.preventDefault();
                  setSeats((current) =>
                    current.map((item) =>
                      item.id === seat.id
                        ? { ...item, blocked: !item.blocked }
                        : item,
                    ),
                  );
                }}
                role="button"
                tabIndex={0}
              >
                <circle cx={seat.x} cy={seat.y} fill={seat.zone_color} r="14" />
                <text dominantBaseline="middle" textAnchor="middle" x={seat.x} y={seat.y}>{seat.number}</text>
                <title>{seat.label} · {seat.blocked ? "Blocked" : "Available"}</title>
              </g>
            ))}
          </svg>
          <div className="seat-zone-legend">
            {zones.map((zone) => (
              <span key={zone.key}><i style={{ backgroundColor: zone.color }} />{zone.name}</span>
            ))}
          </div>
          <p className="seat-designer-hint">
            Reserved-seat ticket capacity must exactly match the number of seats assigned to its zones.
          </p>
        </div>
      </div>
    </section>
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The seat map could not be saved.";
}
