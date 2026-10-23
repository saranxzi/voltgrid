import React, { useState } from 'react';
import { Station, ChargingBay, Vehicle, TariffPlan } from '../types';
import { api } from '../api/client';
import { X, Zap, CheckCircle2, BatteryCharging, AlertTriangle, Calendar, Clock } from 'lucide-react';

interface BookingModalProps {
  station: Station | null;
  bay: ChargingBay | null;
  vehicles: Vehicle[];
  tariffs: TariffPlan[];
  onClose: () => void;
  onSuccess: () => void;
}

const PRESET_SLOTS = [
  { id: 's1', label: '06:00 – 08:00', h1: 6, h2: 8, sub: 'Early Morning Eco' },
  { id: 's2', label: '08:00 – 10:00', h1: 8, h2: 10, sub: 'Morning Commute' },
  { id: 's3', label: '10:00 – 12:00', h1: 10, h2: 12, sub: 'Mid-Morning Fleet' },
  { id: 's4', label: '12:00 – 14:00', h1: 12, h2: 14, sub: 'Mid-Day Standard' },
  { id: 's5', label: '14:00 – 16:00', h1: 14, h2: 16, sub: 'Afternoon SuperFast' },
  { id: 's6', label: '16:00 – 18:00', h1: 16, h2: 18, sub: 'Evening Rush (Peak)', isPeak: true },
  { id: 's7', label: '18:00 – 20:00', h1: 18, h2: 20, sub: 'Prime Peak (Multiplier)', isPeak: true },
  { id: 's8', label: '20:00 – 22:00', h1: 20, h2: 22, sub: 'Night Eco Saver' },
  { id: 's9', label: '22:00 – 00:00', h1: 22, h2: 24, sub: 'Late Night Off-Peak' },
];

export const BookingModal: React.FC<BookingModalProps> = ({
  station,
  bay,
  vehicles,
  tariffs,
  onClose,
  onSuccess
}) => {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>(vehicles[0]?.vehicle_id || '');
  const [selectedTariffId, setSelectedTariffId] = useState<string>(tariffs[0]?.tariff_id || '');
  const [selectedDayOffset, setSelectedDayOffset] = useState<number>(0);
  const [selectedSlotId, setSelectedSlotId] = useState<string>(PRESET_SLOTS[3].id);
  const [initialSoc, setInitialSoc] = useState<number>(20);
  const [targetSoc, setTargetSoc] = useState<number>(80);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const selectedVehicle = vehicles.find(v => v.vehicle_id === selectedVehicleId);
  const selectedTariff = tariffs.find(t => t.tariff_id === selectedTariffId) || tariffs[0];
  const selectedSlot = PRESET_SLOTS.find(s => s.id === selectedSlotId) || PRESET_SLOTS[0];

  const getSlotTimes = (slot: typeof PRESET_SLOTS[0], dayOffset: number) => {
    const start = new Date();
    start.setDate(start.getDate() + dayOffset);
    start.setHours(slot.h1, 0, 0, 0);
    const end = new Date(start);
    if (slot.h2 === 24) {
      end.setDate(end.getDate() + 1);
      end.setHours(0, 0, 0, 0);
    } else {
      end.setHours(slot.h2, 0, 0, 0);
    }
    return { startTime: start.toISOString(), endTime: end.toISOString(), startMs: start.getTime(), endMs: end.getTime() };
  };

  const isSlotBookedOnBay = (slot: typeof PRESET_SLOTS[0]) => {
    const booked = bay?.booked_slots || [];
    if (booked.length === 0) return false;
    const { startMs, endMs } = getSlotTimes(slot, selectedDayOffset);
    return booked.some(b => {
      const bStart = new Date(b.start_time).getTime();
      const bEnd = new Date(b.end_time).getTime();
      return startMs < bEnd && endMs > bStart;
    });
  };

  const isCompatible = bay?.connectors.some(
    c => c.connector_type === selectedVehicle?.connector_type && c.port_status === 'FUNCTIONAL'
  );

  const batteryCap = Number(selectedVehicle?.battery_capacity_kwh || 40.5);
  const energyKwh = Math.max(0, batteryCap * ((targetSoc - initialSoc) / 100));
  const rate = Number(selectedTariff?.base_price_per_kwh || 6.80);
  const peakMult = selectedSlot.isPeak ? Number(selectedTariff?.peak_multiplier || 1.15) : 1.0;
  const estimatedCost = (energyKwh * rate * peakMult).toFixed(2);

  const dateOptions = [0, 1, 2, 3].map(offset => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return {
      offset,
      name: offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short' }),
      date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    };
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bay || !selectedVehicleId || !selectedTariffId) {
      if (vehicles.length === 0) {
        setErrorMsg('No registered EV found for your profile. Please add a vehicle first.');
      }
      return;
    }
    setErrorMsg(null);
    setLoading(true);
    try {
      const { startTime, endTime } = getSlotTimes(selectedSlot, selectedDayOffset);
      await api.bookReservation({
        vehicleId: selectedVehicleId,
        bayId: bay.bay_id,
        tariffId: selectedTariffId,
        startTime,
        endTime,
        initialSoc,
        targetSoc
      });
      setSuccessMsg(`Booking Confirmed! Total: ₹${estimatedCost}`);
      setTimeout(() => { onSuccess(); onClose(); }, 1200);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to book slot');
    } finally {
      setLoading(false);
    }
  };

  if (!station || !bay) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/70 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl max-w-lg w-full p-6 shadow-2xl relative text-zinc-100 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80">
          <div>
            <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-400" /> Reserve Charging Slot
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">{station.station_name} • Bay #{bay.bay_number}</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-zinc-400 hover:text-white rounded-xl hover:bg-zinc-800"><X className="w-4 h-4" /></button>
        </div>

        {errorMsg && (
          <div className="mt-3 p-2.5 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" /><span>{errorMsg}</span>
          </div>
        )}
        {successMsg && (
          <div className="mt-3 p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-xs text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /><span>{successMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-zinc-300 mb-1">Select Your EV</label>
              {vehicles.length === 0 ? (
                <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-2 rounded-xl">
                  No vehicle registered for this persona.
                </div>
              ) : (
                <select
                  value={selectedVehicleId}
                  onChange={(e) => setSelectedVehicleId(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-2.5 py-2 text-zinc-100 text-xs focus:outline-none focus:border-zinc-600"
                >
                  {vehicles.map(v => (
                    <option key={v.vehicle_id} value={v.vehicle_id}>{v.make} {v.model} ({v.connector_type})</option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="block font-medium text-zinc-300 mb-1">Tariff Plan</label>
              <select
                value={selectedTariffId}
                onChange={(e) => setSelectedTariffId(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-2.5 py-2 text-zinc-100 text-xs focus:outline-none focus:border-zinc-600"
              >
                {tariffs.map(t => (
                  <option key={t.tariff_id} value={t.tariff_id}>
                    {t.plan_name} (₹{Number(t.base_price_per_kwh).toFixed(2)}/kWh)
                  </option>
                ))}
              </select>
            </div>
          </div>

          {selectedVehicle && (
            <div className="flex items-center justify-between text-[11px] bg-zinc-950/60 px-3 py-1.5 rounded-xl border border-zinc-800/70">
              <span className="text-zinc-400">Vehicle Port: <strong className="text-zinc-200">{selectedVehicle.connector_type}</strong> • {selectedVehicle.battery_capacity_kwh} kWh</span>
              <span className={isCompatible ? "text-emerald-400 font-medium" : "text-rose-400 font-medium"}>
                {isCompatible ? "✓ Compatible Bay Port" : "✕ Incompatible Bay Port"}
              </span>
            </div>
          )}

          <div>
            <label className="block font-medium text-zinc-300 mb-1 flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5 text-zinc-400" /> Date</label>
            <div className="grid grid-cols-4 gap-2">
              {dateOptions.map(d => (
                <button
                  type="button"
                  key={d.offset}
                  onClick={() => setSelectedDayOffset(d.offset)}
                  className={`py-1.5 px-2 rounded-xl text-center border ${selectedDayOffset === d.offset ? 'bg-zinc-800 border-zinc-600 text-white font-semibold' : 'bg-zinc-950 border-zinc-800/80 text-zinc-400 hover:bg-zinc-800/50'}`}
                >
                  <div className="text-[11px]">{d.name}</div>
                  <div className="text-[10px] text-zinc-500">{d.date}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block font-medium text-zinc-300 mb-1 flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5 text-zinc-400" /> 2-Hour Time Slots</span>
              <span className="text-[10px] text-zinc-500 font-mono">GIST Overlap Protected</span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-40 overflow-y-auto pr-0.5">
              {PRESET_SLOTS.map(s => {
                const isBooked = isSlotBookedOnBay(s);
                return (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => setSelectedSlotId(s.id)}
                    className={`p-2 rounded-xl text-left border transition-colors ${
                      selectedSlotId === s.id
                        ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300 font-semibold'
                        : isBooked
                        ? 'bg-amber-950/20 border-amber-800/40 text-amber-300/80'
                        : 'bg-zinc-950 border-zinc-800/80 text-zinc-300 hover:bg-zinc-800/40'
                    }`}
                  >
                    <div className="text-xs font-mono flex items-center justify-between">
                      <span>{s.label}</span>
                      {isBooked && <span className="text-[9px] px-1 rounded bg-amber-500/20 text-amber-300">Booked</span>}
                    </div>
                    <div className="text-[10px] text-zinc-400 truncate">{s.sub}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="bg-zinc-950 p-3 rounded-2xl border border-zinc-800/80 space-y-2">
            <div className="flex items-center justify-between font-medium">
              <span className="text-zinc-300 flex items-center gap-1.5"><BatteryCharging className="w-3.5 h-3.5 text-emerald-400" /> Target Charge: {initialSoc}% &rarr; {targetSoc}%</span>
              <span className="text-emerald-400 font-mono">{energyKwh.toFixed(1)} kWh needed</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-[10px] text-zinc-400">Current: {initialSoc}%</span>
                <input type="range" min="0" max="80" value={initialSoc} onChange={e => setInitialSoc(Number(e.target.value))} className="w-full accent-emerald-500" />
              </div>
              <div>
                <span className="text-[10px] text-zinc-400">Target: {targetSoc}%</span>
                <input type="range" min={initialSoc + 10} max="100" value={targetSoc} onChange={e => setTargetSoc(Number(e.target.value))} className="w-full accent-emerald-500" />
              </div>
            </div>
            <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between">
              <span className="text-zinc-400">
                Rate: ₹{rate.toFixed(2)}/kWh {selectedSlot.isPeak ? `(×${peakMult} Peak)` : '(Standard)'}
              </span>
              <span className="text-emerald-400 font-bold text-sm font-mono">Total: ₹{estimatedCost}</span>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !isCompatible || vehicles.length === 0}
            className={`w-full py-2.5 rounded-xl font-medium text-xs transition-all ${loading || !isCompatible || vehicles.length === 0 ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm'}`}
          >
            {loading ? 'Confirming Slot...' : `Confirm Booking • ₹${estimatedCost}`}
          </button>
        </form>
      </div>
    </div>
  );
};
