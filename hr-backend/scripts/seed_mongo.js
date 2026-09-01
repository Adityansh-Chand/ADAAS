'use strict';

/**
 * Populate MongoDB with the demo employees.
 *
 *   npm run seed:mongo                     the two demo employees
 *   npm run seed:mongo -- --employees 200   plus 200 synthetic ones
 *   npm run seed:mongo -- --reset           drop the collections first
 *
 * WHY THIS HAD TO EXIST
 *
 * The README says "MongoDB is used when MONGODB_URI is configured and seeded
 * in-memory data otherwise", which is true and was missing the consequence.
 * Nothing in this repository ever wrote an employee into Mongo. So with
 * MONGODB_URI pointing at a working but empty database:
 *
 *   GET  /leave-balance?employee_id=1001   404 Employee not found
 *   POST /leave-application                404 Employee not found
 *
 * Every endpoint 404s and the service is unusable. That was not a hypothetical --
 * it is what a fresh Mongo deployment did, and it went unnoticed because all
 * hundred-odd tests ran on the in-memory fallback and the one live database this
 * project used had been populated by hand at some point in the past.
 *
 * The 404 is correct behaviour, incidentally: an unknown employee id should not
 * silently receive a full entitlement. The gap was that there was no way to make
 * an employee known.
 *
 * THE TWO SOURCES MUST AGREE
 *
 * The in-memory path seeds employee 1001 with 1 casual and 3 combined days used,
 * and 1002 with 3 and 11. This writes exactly those, from the same constant, so
 * switching MONGODB_URI on and off does not change the numbers a reviewer sees. A
 * test asserts the two agree -- because two seed sets that drift apart is how "it
 * works on my machine" gets its reputation, and this project already had one
 * instance of demo data contradicting the policy text it quoted.
 *
 * SYNTHETIC EMPLOYEES ARE DETERMINISTIC
 *
 * `--employees N` generates additional records from a seeded PRNG, so the same N
 * produces the same data on every run and in every checkout. Random usage would
 * make a bug report unreproducible, and "a lot of employees" is exactly the
 * condition under which a per-employee bug -- a missing unique index, a shared
 * document -- actually shows up.
 */

const mongoose = require('mongoose');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const LeaveBalance = require('../models/LeaveBalance');
const LeaveApplication = require('../models/LeaveApplication');
const { ENTITLEMENTS } = require('../leave_rules');

// The same numbers the in-memory path seeds. Imported rather than retyped would
// be better, but server.js starts a listener on require, so it is duplicated here
// and a test asserts the two agree.
const DEMO_USAGE = {
  1001: { casualLeaveUsed: 1, combinedAnnualSickLeaveUsed: 3 },
  1002: { casualLeaveUsed: 3, combinedAnnualSickLeaveUsed: 11 },
};

const SEED = 0x2545f491;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic synthetic employees, ids from 2001 upwards.
 *
 * Usage leaves HEADROOM rather than filling the entitlement. Two reasons, and the
 * second was found the hard way.
 *
 * A record with more days used than the policy grants would produce a negative
 * balance, which every consumer would then have to defend against -- and the
 * invariant "reported balance never exceeds the entitlement" is asserted by a
 * test, so seeding data that violated it would fail the suite for the wrong
 * reason.
 *
 * And an employee seeded exactly AT the cap has nothing left to file, so every
 * leave application from them is correctly refused. The first version of this
 * generated usage up to the full entitlement and the tests exercising the Mongo
 * write path failed against it -- the app was right and the seed data was
 * useless. Synthetic employees who cannot do the thing the app is for are not
 * useful demo data, so RESERVE days are always left free.
 */
const RESERVE = 2;
function syntheticEmployees(count) {
  const random = rng(SEED);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    const id = String(2001 + i);
    out[id] = {
      casualLeaveUsed: Math.floor(
        random() * Math.max(1, ENTITLEMENTS.casual_leave.days - RESERVE + 1),
      ),
      combinedAnnualSickLeaveUsed: Math.floor(
        random() * Math.max(
          1, ENTITLEMENTS.combined_annual_sick_leave.days - RESERVE + 1,
        ),
      ),
    };
  }
  return out;
}

async function seed({ employees = 0, reset = false, uri = process.env.MONGODB_URI } = {}) {
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. This script exists to populate Mongo; with no URI '
      + 'there is nothing to populate, and the service runs on seeded in-memory '
      + 'data instead.',
    );
  }

  await mongoose.connect(uri);
  // connect() can resolve while the connection is still opening, and writing
  // then buffers rather than failing -- which looks like success and is not.
  for (let i = 0; i < 50 && mongoose.connection.readyState !== 1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (reset) {
    await LeaveBalance.deleteMany({});
    await LeaveApplication.deleteMany({});
  }

  const records = { ...DEMO_USAGE, ...syntheticEmployees(employees) };
  let written = 0;
  for (const [employeeId, usage] of Object.entries(records)) {
    // Upsert, so running this twice is not an error and does not double anyone's
    // usage. A seeder that is unsafe to re-run is a seeder nobody re-runs.
    await LeaveBalance.updateOne(
      { employeeId },
      { $set: { employeeId, ...usage } },
      { upsert: true },
    );
    written += 1;
  }

  const total = await LeaveBalance.countDocuments({});
  return { written, total, demo: Object.keys(DEMO_USAGE).length, synthetic: employees };
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--employees');
  const employees = at === -1 ? 0 : Number(args[at + 1] || 0);
  const reset = args.includes('--reset');

  if (Number.isNaN(employees) || employees < 0) {
    console.error('--employees needs a non-negative number');
    process.exit(1);
  }

  console.log('');
  const result = await seed({ employees, reset });
  console.log(`  wrote ${result.written} leave-balance record(s)`);
  console.log(`    ${result.demo} demo employee(s): ${Object.keys(DEMO_USAGE).join(', ')}`);
  if (employees) {
    console.log(`    ${result.synthetic} synthetic, ids 2001-${2000 + employees}, `
      + 'deterministic from a fixed seed');
  }
  console.log(`  ${result.total} employee(s) now in the database`);
  console.log('');
  console.log('  Without this, a connected but empty Mongo 404s every endpoint.');
  console.log('');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`\n${error.message}\n`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { DEMO_USAGE, SEED, RESERVE, syntheticEmployees, seed };
