/**
 * QA-R3: prescriptionExerciseId lifecycle tests
 *
 * Findings tested:
 *   QA-R3-01: showUpdatePlanModal strips prescriptionExerciseIds before stampPrescriptionIds,
 *             causing all exercises to receive new IDs on every "update plan in-place" operation.
 *   QA-R3-02: Template-plan addDoc payloads omit updatedAt, causing the live plan listener
 *             to skip the first coach edit (sets baseline instead of triggering reload).
 *
 * Uses the assert-style harness — NO Jest/expect/describe.
 */
'use strict';
var assert = require('assert');
var PASS = 0, FAIL = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch (e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

// ── Helpers replicated from vdsen-coach.html ─────────────────────────────────

function _genPrescriptionId() {
  return 'pid_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function _stampPrescriptionIds(days) {
  var seen = {};
  return (days || []).map(function(day) {
    return Object.assign({}, day, {
      exercises: (day.exercises || []).map(function(ex) {
        var id = ex.prescriptionExerciseId;
        if (id && !seen[id]) { seen[id] = true; return ex; }
        var newId = _genPrescriptionId();
        while (seen[newId]) { newId = _genPrescriptionId(); }
        seen[newId] = true;
        return Object.assign({}, ex, { prescriptionExerciseId: newId });
      })
    });
  });
}

// Replicates the exercise normalization inside showUpdatePlanModal (vdsen-coach.html ~17281)
// NOTE: does NOT pass prescriptionExerciseId through — this is the bug under test.
function normalizeExerciseForUpdateModal(ex, si) {
  return {
    exerciseName: String(ex.exerciseName || '').trim(),
    alternatives: [],
    technique: String(ex.technique || 'straight').toLowerCase().trim(),
    techniqueNote: String(ex.techniqueNote || '').trim(),
    coachNote: String(ex.coachNote || '').trim(),
    supersetGroup: String(ex.supersetGroup || '').trim(),
    nivel_medio: null,
    variacion_vertical: null,
    sets: (ex.sets || []).map(function(s, i) {
      return {
        setIndex: typeof s.setIndex === 'number' ? s.setIndex : i,
        repsTarget: parseInt(s.repsTarget) || 8,
        rirTarget: parseInt(s.rirTarget != null ? s.rirTarget : 2),
        load: parseFloat(s.load || 0) || 0,
        restSeconds: parseInt(s.restSeconds || 90) || 90,
        setNote: String(s.setNote || '').trim(),
        drop: s.drop === true,
        tempo: String(s.tempo || '').trim()
      };
    })
    // prescriptionExerciseId intentionally omitted — mirrors production code
  };
}

function showUpdatePlanModal_normalize(days) {
  return days.map(function(d, di) {
    return {
      dayIndex: typeof d.dayIndex === 'number' ? d.dayIndex : di,
      label: String(d.label || ('Día ' + (di + 1))),
      exercises: (d.exercises || [])
        .map(normalizeExerciseForUpdateModal)
        .filter(function(ex) { return ex.exerciseName.length > 1 && ex.sets.length > 0; })
    };
  }).filter(function(d) { return d.exercises.length > 0; });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

var sourceDays = [
  {
    dayIndex: 0,
    label: 'Día 1',
    exercises: [
      {
        exerciseName: 'Sentadilla',
        prescriptionExerciseId: 'pid-existing-A',
        sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2, load: 100, restSeconds: 180 }]
      },
      {
        exerciseName: 'Prensa',
        prescriptionExerciseId: 'pid-existing-B',
        sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 2, load: 200, restSeconds: 120 }]
      }
    ]
  }
];

// ── QA-R3-01: showUpdatePlanModal discards prescriptionExerciseIds ─────────────

test('QA-R3-01a: normalizeExercise drops prescriptionExerciseId field', function() {
  var normalized = normalizeExerciseForUpdateModal(sourceDays[0].exercises[0]);
  assert.strictEqual(
    normalized.prescriptionExerciseId,
    undefined,
    'prescriptionExerciseId should be absent after normalization (mirrors production bug)'
  );
});

test('QA-R3-01b: _stampPrescriptionIds assigns NEW ids when normalization drops old ids', function() {
  var normalized = showUpdatePlanModal_normalize(sourceDays);
  var stamped    = _stampPrescriptionIds(normalized);

  var newIdA = stamped[0].exercises[0].prescriptionExerciseId;
  var newIdB = stamped[0].exercises[1].prescriptionExerciseId;

  assert.ok(newIdA, 'Exercise A should have been assigned a new ID');
  assert.ok(newIdB, 'Exercise B should have been assigned a new ID');
  assert.notStrictEqual(newIdA, 'pid-existing-A',
    'QA-R3-01 CONFIRMED: showUpdatePlanModal discards old prescriptionExerciseId for Exercise A');
  assert.notStrictEqual(newIdB, 'pid-existing-B',
    'QA-R3-01 CONFIRMED: showUpdatePlanModal discards old prescriptionExerciseId for Exercise B');
  assert.notStrictEqual(newIdA, newIdB, 'Generated IDs must be unique within the plan');
});

test('QA-R3-01c: _stampPrescriptionIds preserves id when field IS present (control)', function() {
  // Shows that _stampPrescriptionIds itself is correct — the problem is upstream normalization
  var daysWithIds = [
    {
      exercises: [
        { exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-keep-me',
          sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2, load: 80, restSeconds: 120 }] }
      ]
    }
  ];
  var stamped = _stampPrescriptionIds(daysWithIds);
  assert.strictEqual(
    stamped[0].exercises[0].prescriptionExerciseId,
    'pid-keep-me',
    '_stampPrescriptionIds should preserve existing IDs when present'
  );
});

// ── QA-R3-02: Template plan payloads omit updatedAt ──────────────────────────

test('QA-R3-02a: template plan payload (apply-to-client path) has no updatedAt', function() {
  // Replicates vdsen-coach.html ~15276 addDoc payload
  var templatePayload = {
    days:        [{ dayIndex: 0, label: 'Día 1', exercises: [] }],
    weeks:       6,
    daysPerWeek: 1,
    coachId:     'uid-coach',
    clientId:    'uid-client',
    status:      'active',
    generatedBy: 'template:Test Template',
    createdAt:   new Date().toISOString()
    // updatedAt: intentionally absent — mirrors production code
  };
  assert.strictEqual(
    templatePayload.updatedAt,
    undefined,
    'QA-R3-02 CONFIRMED: template apply-to-client path omits updatedAt from addDoc payload'
  );
});

test('QA-R3-02b: template plan payload (quick-assign path) has no updatedAt', function() {
  // Replicates vdsen-coach.html ~17736 addDoc payload
  var quickAssignPayload = {
    days:        _stampPrescriptionIds([]),
    weeks:       6,
    daysPerWeek: 0,
    coachId:     'uid-coach',
    clientId:    'uid-client',
    status:      'active',
    generatedBy: 'template:Test',
    createdAt:   new Date().toISOString()
    // updatedAt: intentionally absent — mirrors production code
  };
  assert.strictEqual(
    quickAssignPayload.updatedAt,
    undefined,
    'QA-R3-02 CONFIRMED: template quick-assign path omits updatedAt from addDoc payload'
  );
});

test('QA-R3-02c: live listener baseline logic skips first write when plan has no updatedAt', function() {
  // Replicates vdsen-cliente.html ~1701-1715 live listener logic
  var planLastUpdatedAt = null; // FB._planLastUpdatedAt

  function simulateListenerFire(updatedAt) {
    if (!updatedAt) return 'IGNORED_NO_TIMESTAMP';
    if (!planLastUpdatedAt) { planLastUpdatedAt = updatedAt; return 'BASELINE_SET'; }
    if (updatedAt === planLastUpdatedAt) return 'IGNORED_NO_CHANGE';
    planLastUpdatedAt = updatedAt;
    return 'RELOAD_TRIGGERED';
  }

  // Template plan created — no updatedAt — listener fires on initial subscription
  assert.strictEqual(simulateListenerFire(''), 'IGNORED_NO_TIMESTAMP',
    'Empty updatedAt: listener ignores the event');

  // Coach runs saveTrainingPlan (first write) → updatedAt now populated
  var firstWrite = '2026-09-16T10:00:00.000Z';
  assert.strictEqual(simulateListenerFire(firstWrite), 'BASELINE_SET',
    'First write after no-updatedAt plan sets baseline — NO client reload triggered');

  // Coach runs saveTrainingPlan (second write) → different updatedAt
  var secondWrite = '2026-09-16T10:05:00.000Z';
  assert.strictEqual(simulateListenerFire(secondWrite), 'RELOAD_TRIGGERED',
    'Second write triggers client reload as expected');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
