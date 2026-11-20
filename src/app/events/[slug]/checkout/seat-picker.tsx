"use client";

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { bestAvailableSeats, type SeatMapData } from "@/lib/seating";

export function SeatPicker({
  seatMap,
  ticketTypeId,
  quantity,
  selectedIds,
  onChange,
}: {
  seatMap: SeatMapData;
  ticketTypeId: number;
  quantity: number;
  selectedIds: number[];
  onChange: (seatIds: number[]) => void;
}) {
  const [scale, setScale] = useState(1);
  const [viewOrigin, setViewOrigin] = useState({ x: 0, y: 0 });
  const [panStart, setPanStart] = useState<{
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const viewWidth = seatMap.width / scale;
  const viewHeight = seatMap.height / scale;
  const eligibleCount = seatMap.seats.filter(
    (seat) =>
      seat.ticket_type_id === ticketTypeId && seat.available && !seat.blocked,
  ).length;

  function toggleSeat(seatId: number) {
    const seat = seatMap.seats.find((item) => item.id === seatId);
    if (
      !seat ||
      seat.ticket_type_id !== ticketTypeId ||
      !seat.available ||
      seat.blocked
    ) {
      return;
    }
    if (selected.has(seatId)) {
      onChange(selectedIds.filter((id) => id !== seatId));
    } else if (selectedIds.length < quantity) {
      onChange([...selectedIds, seatId]);
    }
  }

  function keyboardToggle(event: KeyboardEvent<SVGGElement>, seatId: number) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleSeat(seatId);
    }
  }

  function beginPan(event: PointerEvent<SVGSVGElement>) {
    if (event.target !== event.currentTarget || scale <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanStart({
      x: event.clientX,
      y: event.clientY,
      originX: viewOrigin.x,
      originY: viewOrigin.y,
    });
  }

  function movePan(event: PointerEvent<SVGSVGElement>) {
    if (!panStart) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const nextX =
      panStart.originX -
      ((event.clientX - panStart.x) / bounds.width) * viewWidth;
    const nextY =
      panStart.originY -
      ((event.clientY - panStart.y) / bounds.height) * viewHeight;
    setViewOrigin({
      x: Math.max(0, Math.min(seatMap.width - viewWidth, nextX)),
      y: Math.max(0, Math.min(seatMap.height - viewHeight, nextY)),
    });
  }

  function zoomBy(amount: number) {
    const nextScale = Math.max(1, Math.min(3, scale + amount));
    setScale(nextScale);
    setViewOrigin({
      x: Math.min(viewOrigin.x, seatMap.width - seatMap.width / nextScale),
      y: Math.min(viewOrigin.y, seatMap.height - seatMap.height / nextScale),
    });
  }

  function chooseBestAvailable() {
    const recommended = bestAvailableSeats(
      seatMap.seats,
      ticketTypeId,
      quantity,
    );
    onChange(recommended.map((seat) => seat.id));
  }

  return (
    <section className="seat-picker" aria-label="Choose reserved seats">
      <header className="seat-picker-header">
        <div>
          <strong>Choose your seats</strong>
          <span>
            {selectedIds.length} of {quantity} selected · {eligibleCount} available
          </span>
        </div>
        <div className="seat-map-zoom" aria-label="Seat map zoom">
          <button
            aria-label="Zoom out"
            disabled={scale <= 1}
            onClick={() => zoomBy(-0.5)}
            type="button"
          >
            −
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button
            aria-label="Zoom in"
            disabled={scale >= 3}
            onClick={() => zoomBy(0.5)}
            type="button"
          >
            +
          </button>
        </div>
      </header>
      <svg
        aria-label="Interactive seat map; use arrow keys to navigate and Enter to select"
        className={`seat-map-canvas${scale > 1 ? " seat-map-canvas--zoomed" : ""}`}
        onPointerCancel={() => setPanStart(null)}
        onPointerDown={beginPan}
        onPointerMove={movePan}
        onPointerUp={() => setPanStart(null)}
        role="group"
        viewBox={`${viewOrigin.x} ${viewOrigin.y} ${viewWidth} ${viewHeight}`}
      >
        <rect
          className="seat-map-stage"
          data-pan="true"
          height="28"
          rx="9"
          width={seatMap.width * 0.62}
          x={seatMap.width * 0.19}
          y="22"
        />
        <text
          className="seat-map-stage-label"
          data-pan="true"
          textAnchor="middle"
          x={seatMap.width / 2}
          y="41"
        >
          STAGE
        </text>
        {seatMap.seats.map((seat) => {
          const canSelect =
            seat.ticket_type_id === ticketTypeId &&
            seat.available &&
            !seat.blocked;
          const isSelected = selected.has(seat.id);
          return (
            <g
              aria-checked={isSelected}
              aria-label={`Seat ${seat.label}, ${
                isSelected ? "selected" : canSelect ? "available" : "unavailable"
              }`}
              className={[
                "seat-map-seat",
                canSelect ? "seat-map-seat--available" : "seat-map-seat--unavailable",
                isSelected ? "seat-map-seat--selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={seat.id}
              onClick={() => toggleSeat(seat.id)}
              onKeyDown={(event) => keyboardToggle(event, seat.id)}
              role="checkbox"
              tabIndex={canSelect || isSelected ? 0 : -1}
            >
              <circle
                cx={seat.x}
                cy={seat.y}
                fill={isSelected ? undefined : seat.zone_color}
                r="14"
              />
              <text
                dominantBaseline="middle"
                textAnchor="middle"
                x={seat.x}
                y={seat.y}
              >
                {seat.number}
              </text>
              <title>
                {seat.label} · {seatMap.zones.find((zone) => zone.key === seat.zone_key)?.name}
              </title>
            </g>
          );
        })}
      </svg>
      <div className="seat-picker-footer">
        <div className="seat-zone-legend">
          {seatMap.zones.map((zone) => (
            <span key={zone.key}>
              <i style={{ backgroundColor: zone.color }} />
              {zone.name} · {zone.ticket_name}
            </span>
          ))}
          <span><i className="seat-legend-unavailable" />Unavailable</span>
          <span><i className="seat-legend-selected" />Selected</span>
        </div>
        <button
          className="checkout-secondary"
          disabled={eligibleCount < quantity}
          onClick={chooseBestAvailable}
          type="button"
        >
          Best available
        </button>
      </div>
      {selectedIds.length !== quantity && (
        <p className="seat-selection-hint" role="status">
          Select {quantity - selectedIds.length} more{" "}
          {quantity - selectedIds.length === 1 ? "seat" : "seats"} to continue.
        </p>
      )}
    </section>
  );
}
