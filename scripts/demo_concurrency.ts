/**
 * VoltGrid Concurrency & ACID Race Condition Live Benchmark
 * Demonstrates PostgreSQL btree_gist Exclusion Constraint & Stored Proc Atomic Locking
 * 
 * Usage:
 *   npx tsx scripts/demo_concurrency.ts
 */

const API_BASE = process.env.API_URL || 'http://localhost:5000/api';

// ANSI color helpers for terminal presentation
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function runConcurrencyDemo() {
  console.log('\n' + '='.repeat(70));
  console.log(bold(cyan('⚡ VoltGrid Concurrency Race Condition Benchmark (ACID Isolation)')));
  console.log('='.repeat(70));
  console.log(dim(`Target Server: ${API_BASE}\n`));

  try {
    // Step 1: Authenticate as Aarav Patel
    console.log(cyan('1. Authenticating test driver (aarav.patel@gmail.com)...'));
    const loginRes = await fetch(`${API_BASE}/auth/quick-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'aarav.patel@gmail.com' })
    });

    if (!loginRes.ok) {
      throw new Error(`Auth failed with HTTP ${loginRes.status}: ${await loginRes.text()}`);
    }

    const loginData = await loginRes.json();
    const token = loginData.token;
    const vehicle = loginData.user.vehicles?.[0];

    if (!vehicle) {
      throw new Error('No registered vehicle found for Aarav Patel.');
    }
    console.log(green(`   ✓ Authenticated as ${loginData.user.firstName} ${loginData.user.lastName} (Vehicle: ${vehicle.licensePlate || vehicle.license_plate})`));

    // Step 2: Fetch Stations & Tariffs to target Bay 1
    console.log(cyan('2. Resolving target charging bay and tariff...'));
    const [stationsRes, tariffsRes] = await Promise.all([
      fetch(`${API_BASE}/stations`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${API_BASE}/stations/tariffs`, { headers: { Authorization: `Bearer ${token}` } })
    ]);

    const stationsData = await stationsRes.json();
    const tariffsData = await tariffsRes.json();

    const station = stationsData.data?.[0];
    const bay = station?.bays?.find((b: any) => b.bay_status === 'AVAILABLE') || station?.bays?.[0];
    const tariff = tariffsData.data?.[0];

    if (!bay || !tariff) {
      throw new Error('Unable to find available charging bay or tariff plan.');
    }

    console.log(green(`   ✓ Target Station: ${station.station_name}`));
    console.log(green(`   ✓ Target Bay ID : ${bay.bay_id} (Bay #${bay.bay_number})`));
    console.log(green(`   ✓ Tariff Plan   : ${tariff.plan_name} (₹${tariff.base_price_per_kwh}/kWh)`));

    // Step 3: Define identical, conflicting time window (Tomorrow 14:00 - 16:00 UTC)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setUTCHours(14, 0, 0, 0);
    const startTime = tomorrow.toISOString();

    tomorrow.setUTCHours(16, 0, 0, 0);
    const endTime = tomorrow.toISOString();

    const bookingPayload = {
      vehicleId: vehicle.vehicleId || vehicle.vehicle_id,
      bayId: bay.bay_id,
      tariffId: tariff.tariff_id,
      startTime,
      endTime,
      initialSoc: 25,
      targetSoc: 85
    };

    console.log('\n' + cyan('3. Firing TWO simultaneous booking requests for the EXACT same bay & slot:'));
    console.log(dim(`   Bay: ${bay.bay_id} | Window: ${startTime} -> ${endTime}`));
    console.log(yellow('   [Thread Alpha] POST /reservations/book'));
    console.log(yellow('   [Thread Beta ] POST /reservations/book'));

    // Step 4: Dispatch concurrent requests via Promise.all
    const tStart = performance.now();
    const [resAlpha, resBeta] = await Promise.all([
      fetch(`${API_BASE}/reservations/book`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(bookingPayload)
      }),
      fetch(`${API_BASE}/reservations/book`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(bookingPayload)
      })
    ]);
    const duration = (performance.now() - tStart).toFixed(2);

    const dataAlpha = await resAlpha.json();
    const dataBeta = await resBeta.json();

    console.log(`\n${bold('--- Execution Results in ' + duration + 'ms ---')}`);
    console.log(`Thread Alpha -> HTTP ${resAlpha.status}: ${JSON.stringify(dataAlpha)}`);
    console.log(`Thread Beta  -> HTTP ${resBeta.status}: ${JSON.stringify(dataBeta)}\n`);

    // Step 5: Verify ACID exclusion invariants
    const created = resAlpha.status === 201 ? dataAlpha : resBeta.status === 201 ? dataBeta : null;
    const rejected = resAlpha.status === 409 ? dataAlpha : resBeta.status === 409 ? dataBeta : null;

    if (created && rejected) {
      console.log('='.repeat(70));
      console.log(bold(green('🎉 ACID INVARIANT VERIFIED: ZERO DOUBLE-BOOKING ANOMALY!')));
      console.log('='.repeat(70));
      console.log(green(`✓ Exactly ONE transaction succeeded (HTTP 201 Created)`));
      console.log(green(`  Reservation ID: ${created.reservationId}`));
      console.log(red(`✓ Competing transaction was atomically REJECTED (HTTP 409 Conflict)`));
      console.log(red(`  Reason: ${rejected.message || rejected.status}`));
      console.log(dim(`\nPostgreSQL Engine Invariant:`));
      console.log(cyan(`  CONSTRAINT no_overlapping_active_reservations`));
      console.log(cyan(`  EXCLUDE USING gist (bay_id WITH =, tstzrange(start_time, end_time) WITH &&);`));
      console.log('='.repeat(70));

      // Cleanup: Cancel created demo reservation to leave DB clean
      console.log(dim(`\nCleaning up demo reservation (${created.reservationId})...`));
      await fetch(`${API_BASE}/reservations/${created.reservationId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log(green('✓ Cleanup completed. Benchmark is fully repeatable.\n'));
    } else {
      console.log(red('⚠️ Unexpected outcome. Check backend server logs.'));
    }
  } catch (err: any) {
    console.error(red('\n❌ Benchmark Error:'), err.message);
    console.log(dim('Ensure the VoltGrid backend server is running on http://localhost:5000'));
    process.exit(1);
  }
}

runConcurrencyDemo();
