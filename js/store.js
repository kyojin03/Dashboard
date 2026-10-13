/**
 * Store — application state + explicit Demo mode.
 * Demo data is clearly labeled and NEVER mixed with production data:
 *  - demo mode keeps everything in memory from SAMPLE_DATA
 *  - live mode keeps everything from the Apps Script API
 * Switching modes resets state so the two can never mix.
 */
(function () {
  var SAMPLE = null;

  var state = {
    mode: 'live', // 'live' (default) | 'demo' (explicit action only)
    members: [],
    tasks: [],
    updates: [],
    workLogs: [],
    impacts: [],
    snapshots: [],
    settings: { timezone: 'Asia/Manila' },
    selectedMember: 'ALL',
    weekStart: monday(new Date()),
    loading: false,
    error: '',
    errorKind: '',
    connected: false // true only after a successful live initLoad
  };

  function monday(d) {
    // Monday of the reporting week in Asia/Manila (not the browser's zone),
    // so the week scope matches the backend for all users.
    var x = new Date(d);
    var wd;
    try {
      var name = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' }).format(x);
      wd = { Sun: 6, Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5 }[name];
    } catch (e) {
      wd = (x.getDay() + 6) % 7; // fallback: browser-local Monday
    }
    if (wd === undefined) wd = (x.getDay() + 6) % 7;
    // Step back wd days on the UTC calendar date derived from the input.
    var base = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
    // Correct the base to the Manila calendar date first.
    try {
      var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(x).split('-');
      base = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    } catch (e) { /* keep UTC fallback */ }
    base.setUTCDate(base.getUTCDate() - wd);
    return base.toISOString().slice(0, 10);
  }

  function uid(p) {
    return p + '_' + Math.random().toString(36).slice(2, 10);
  }

  function seedDemo() {
    var now = new Date().toISOString();
    var wk = state.weekStart;
    function day(n, h) {
      var d = new Date(wk + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + n);
      d.setUTCHours(h || 9, 0, 0, 0);
      return d.toISOString();
    }
    var members = [
      ['M001', 'Michelle Ann F. Pablo', 'Academic Affairs Director'],
      ['M002', 'Michelle M. Macatangay', 'Academic Affairs Manager'],
      ['M003', 'Divina G. Asuncion', 'Academic Development and Alumni Associate'],
      ['M004', 'Kathlyn Kate N. Mauricio', 'Training Development and Extension Associate'],
      ['M005', 'Juhayna M. Sultan', 'Research Assistant'],
      ['M006', 'Catherine M. Madriaga', 'Administrative Assistant'],
      ['M007', 'Jemima P. Sarmiento', 'Laboratory Technician'],
      ['M008', 'Piolo B. Bernardino', 'Learning Management Associate'],
      ['M009', 'Perly S. Saldivar', 'OVPAA Clerk'],
      ['M010', 'Rhea Duremdes', 'Academic Affairs Secretary'],
      ['M011', 'Jerome Balbuena', 'Laboratory Custodian']
    ].map(function (m) {
      return { member_id: m[0], display_name: m[1], role: m[2], department: 'Academic Affairs', is_active: 'TRUE', created_at: now };
    });
    var tasks = [
      {
        task_id: 'T_DEMO_1', title: 'Consolidate enrollment reports', description: 'Expected output: summary tables per program.',
        owner_id: 'M002', task_type: 'PLANNED', requested_by: 'Director', created_at: day(0, 8),
        started_at: day(0, 9), original_due_at: day(4, 17), current_due_at: day(4, 17), completed_at: '',
        priority: 'High', status: 'In Progress', completion_percent: 60, estimated_minutes: 480,
        actual_minutes: 300, blocked_reason: '', impact_reason: '', impact_notes: '', created_by: 'M002',
        last_updated_at: now, archived_at: ''
      },
      {
        task_id: 'T_DEMO_2', title: 'Urgent accreditation documents', description: 'Requested mid-week by the Director.',
        owner_id: 'M002', task_type: 'ADDITIONAL', requested_by: 'Academic Affairs Director', created_at: day(2, 10),
        started_at: day(2, 11), original_due_at: day(3, 17), current_due_at: day(3, 17), completed_at: day(3, 15),
        priority: 'Urgent', status: 'Completed', completion_percent: 100, estimated_minutes: 180,
        actual_minutes: 210, blocked_reason: '', impact_reason: 'Urgent supervisor request', impact_notes: 'Delivered compiled annexes.',
        created_by: 'M002', last_updated_at: now, archived_at: ''
      },
      {
        task_id: 'T_DEMO_3', title: 'Calibrate laboratory instruments', description: 'Weekly calibration run.',
        owner_id: 'M007', task_type: 'PLANNED', requested_by: 'Lab Supervisor', created_at: day(0, 8),
        started_at: '', original_due_at: day(5, 17), current_due_at: day(5, 17), completed_at: '',
        priority: 'Medium', status: 'Blocked', completion_percent: 20, estimated_minutes: 240,
        actual_minutes: 60, blocked_reason: 'Waiting for replacement reagents.', impact_reason: '',
        impact_notes: '', created_by: 'M007', last_updated_at: now, archived_at: ''
      }
    ];
    SAMPLE = { members: members, tasks: tasks };
    state.members = members;
    state.tasks = tasks;
    state.updates = [
      {
        update_id: 'U_DEMO_1', task_id: 'T_DEMO_1', member_id: 'M002', update_date: wk,
        previous_percent: 30, new_percent: 60, accomplishment_notes: 'Drafted program tables; validation pending.',
        remaining_work: 'Validate registrar figures.', blocker_notes: '', created_at: now
      }
    ];
    state.workLogs = [
      { work_log_id: 'W_DEMO_1', task_id: 'T_DEMO_1', member_id: 'M002', work_date: wk, start_time: '', end_time: '', minutes_spent: 180, work_category: 'Analysis', notes: '', created_at: now },
      { work_log_id: 'W_DEMO_2', task_id: 'T_DEMO_2', member_id: 'M002', work_date: wk, start_time: '', end_time: '', minutes_spent: 210, work_category: 'Urgent request', notes: '', created_at: now }
    ];
    state.impacts = [
      {
        impact_id: 'I_DEMO_1', additional_task_id: 'T_DEMO_2', affected_task_id: 'T_DEMO_1',
        impact_type: 'Delayed', estimated_delay_minutes: 120, actual_delay_minutes: 120,
        reason: 'Urgent supervisor request', evidence_notes: 'Accreditation annexes took priority Tue–Wed; see daily updates.',
        created_by: 'M002', created_at: now, updated_at: now
      }
    ];
    state.snapshots = [];
  }

  window.Store = {
    state: state,
    monday: monday,
    uid: uid,
    enterDemo: function () {
      state.mode = 'demo';
      state.connected = false;
      state.error = '';
      seedDemo();
    },
    enterLive: function (data) {
      state.mode = 'live';
      state.connected = true;
      state.error = '';
      state.members = data.members || [];
      state.tasks = data.tasks || [];
      state.settings = data.settings || state.settings;
      state.updates = [];
      state.workLogs = [];
      state.impacts = [];
    },
    setError: function (msg) { state.error = msg || ''; },
    isDemo: function () { return state.mode === 'demo'; }
  };
})();
