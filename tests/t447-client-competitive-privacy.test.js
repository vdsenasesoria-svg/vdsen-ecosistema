'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const clientPath = path.join(__dirname, '..', 'vdsen-cliente.html');
const coachPath = path.join(__dirname, '..', 'vdsen-coach.html');
const client = fs.readFileSync(clientPath, 'utf8');
const coach = fs.readFileSync(coachPath, 'utf8');
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; console.log('  ✓ ' + message); }

const start = client.indexOf('function _clientModuleIsVisible(');
const end = client.indexOf('async function loadPlan(', start);
ok(start >= 0 && end > start, 'client defines a read-only advanced-module adapter before plan loading');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(client.slice(start, end), sandbox);

let state = sandbox._buildClientAdvancedState({ competitivePhysique:{ event:'Regional' } }, {});
ok(state.competitivePhysique === null, 'competitive data is hidden when explicit client visibility is absent');

state = sandbox._buildClientAdvancedState({
  competitivePhysique:{ clientVisible:true, event:'Regional', posing:{ poses:['Front pose'] } },
  healthSurveillance:{ symptoms:['fatigue'] },
  pharmacologyContext:{ agents:['reported'] }
}, {});
ok(state.competitivePhysique && state.posing, 'visible competitive container exposes its client modules');
ok(state.healthSurveillance === null && state.pharmacologyContext === null, 'health and pharmacology never inherit competitive visibility');

state = sandbox._buildClientAdvancedState({
  healthSurveillance:{ clientVisible:true, pendingChecks:['labs'] },
  pharmacologyContext:{ clientVisible:true, reportedAgents:['agent'] }
}, {});
ok(state.healthSurveillance && state.pharmacologyContext, 'sensitive modules appear only with their own explicit authorization');

ok(client.includes("NOT_READY:'Aún no listo'") && client.includes("ON_TRACK:'En ruta'") && client.includes("MEASUREMENT_UNCERTAIN:'Información aún insuficiente'"), 'stage-readiness states use qualitative client language');
ok(client.includes("_advModule('CARDIO'") && client.includes("_advModule('PASOS / NEAT'"), 'cardio and NEAT are rendered as separate domains');

const pharmBlock = client.slice(client.indexOf("_advModule('MEDICACIÓN / CONTEXTO FARMACOLÓGICO'"), client.indexOf("return '<section class=\"advanced-client\">"));
ok(!/dose|dosis|cycle|ciclo|stack|pct/i.test(pharmBlock), 'pharmacology UI whitelist excludes doses, cycles, stacks and PCT');
ok(client.includes("peak.approved === true && peak.clientVisible === true"), 'peak-week fluids and sodium require approved, client-visible data');
ok(client.includes("_ciOptionalNumber('pasos'") && client.includes("_ciOptionalText('sintomas'"), 'check-in accepts optional steps, cardio, posing, recovery and symptom fields');

ok(!coach.includes('CLIENT_ADVANCED') && !coach.includes('buildAdvancedClientOverview'), 'Coach App has no competitive client implementation injected');

console.log('\nT447 — Competitive privacy/read-only UI: ' + pass + ' assertions PASSED.');
