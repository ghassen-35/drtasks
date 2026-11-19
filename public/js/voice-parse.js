// تحويل جملة منطوقة إلى مهمة بتفاصيلها: العنوان، الأولوية، الموعد والوقت، المسؤول، القسم، التكرار، المخرج المطلوب.
// يعمل في المتصفح (window.parseVoiceTask) وفي Node للاختبار (module.exports). لا يحتاج اتصالًا ولا خدمة خارجية.
(function (root) {
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const toLatin = (s) => s.replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d))).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  // تطبيع للمطابقة فقط (لا يغيّر النص المعروض): بلا تشكيل ولا تطويل، وتوحيد الهمزات والياء والتاء المربوطة
  const norm = (s) => toLatin(String(s || '')).replace(/[ً-ْٰـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();

  const WEEKDAYS = [['الاحد', 0], ['الاثنين', 1], ['الاتنين', 1], ['الثلاثاء', 2], ['الثلاثا', 2], ['الاربعاء', 3], ['الاربعا', 3], ['الخميس', 4], ['الجمعه', 5], ['السبت', 6]];
  const MONTHS = [['يناير', 1], ['فبراير', 2], ['مارس', 3], ['ابريل', 4], ['مايو', 5], ['يونيو', 6], ['يوليو', 7], ['اغسطس', 8], ['سبتمبر', 9], ['اكتوبر', 10], ['نوفمبر', 11], ['ديسمبر', 12]];
  const WORD_NUM = { 'واحد': 1, 'يوم': 1, 'يومين': 2, 'اثنين': 2, 'ثلاث': 3, 'ثلاثه': 3, 'اربع': 4, 'اربعه': 4, 'خمس': 5, 'خمسه': 5, 'ست': 6, 'سته': 6, 'سبع': 7, 'سبعه': 7, 'عشر': 10, 'عشره': 10 };

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const add = (today, n) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const dow = (today) => new Date(today + 'T12:00:00Z').getUTCDay();

  // نبحث في النص المطبَّع، ونحذف المطابق من النص الأصلي بالموضع نفسه (التطبيع لا يغيّر الطول إلا بحذف التشكيل، لذا نحذفه من الأصل أولًا)
  function parseVoiceTask(raw, ctx = {}) {
    const today = ctx.today || iso(new Date());
    let text = toLatin(String(raw || '')).replace(/[ً-ْٰـ]/g, '').replace(/\s+/g, ' ').trim();
    const out = { title: '', priority: 'normal', due_date: null, due_time: null, assignee_id: null, assignee_name: null, section: null, recurrence: null, deliverable: null, found: [] };
    // يزيل أول مطابقة لنمط من النص، ويعيد المطابقة
    const take = (re) => {
      const n = norm(text); const m = n.match(re);
      if (!m) return null;
      text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
      return m;
    };

    // افتتاحيات لا تدخل في العنوان
    take(/^(?:لو سمحت|من فضلك|يا )?\s*(?:سجل|سجلي|اضف|اضيف|ضيف|انشئ|اكتب|ابي|ابغي|ابغا|اريد|نبي|نبغي|نريد)?\s*(?:لي|لنا)?\s*(?:مهمه جديده|مهمه|تكليف|موضوع)?\s*[:،,-]?\s*(?=\S)/);

    // المخرج المطلوب: «والمطلوب …» أو «المخرج …» حتى نهاية الجملة أو أول فاصلة
    const del = take(/(?:^|\s)و?(?:المطلوب(?: هو)?|المخرج(?: المطلوب)?|المطلوب تسليمه)\s*[:،]?\s*([^،,.]+)/);
    if (del) { out.deliverable = cleanEnds(del[1]); out.found.push('deliverable'); }

    // الأولوية
    if (take(/(?:^|\s)(?:بشكل |بصفه |وبشكل )?(?:عاجل|عاجله|ضروري|ضروريه|فوري|مستعجل|مستعجله)(?=\s|$|[،,.:؛!])/)) { out.priority = 'urgent'; out.found.push('priority'); }
    else if (take(/(?:^|\s)(?:مهم جدا|مهمه جدا|اولويه عاليه|مهم)(?=\s|$|[،,.:؛!])/)) { out.priority = 'important'; out.found.push('priority'); }

    // التكرار
    const rec = take(/(?:^|\s)(?:كل يوم|يوميا|بشكل يومي|كل اسبوع|اسبوعيا|بشكل اسبوعي|كل شهر|شهريا|بشكل شهري|كل سنه|سنويا)(?=\s|$|[،,.:؛!])/);
    if (rec) { const r = rec[0]; out.recurrence = /يوم/.test(r) ? 'daily' : /اسبوع/.test(r) ? 'weekly' : /شهر/.test(r) ? 'monthly' : 'yearly'; out.found.push('recurrence'); }

    // الوقت: «الساعة 10»، «الساعة عشرة ونص صباحًا»، «10:30»
    const HOURS = { 'واحده': 1, 'وحده': 1, 'ثنتين': 2, 'اثنين': 2, 'ثلاث': 3, 'ثلاثه': 3, 'اربع': 4, 'اربعه': 4, 'خمس': 5, 'خمسه': 5, 'ست': 6, 'سته': 6, 'سبع': 7, 'سبعه': 7, 'ثمان': 8, 'ثمانيه': 8, 'ثمنيه': 8, 'تسع': 9, 'تسعه': 9, 'عشر': 10, 'عشره': 10, 'احدعش': 11, 'احدي عشر': 11, 'احدي عشره': 11, 'اثنعش': 12, 'اثني عشر': 12, 'اثني عشره': 12 };
    const hw = Object.keys(HOURS).sort((a, b) => b.length - a.length).join('|');
    const tm = take(new RegExp('(?:^|\\s)(?:في |علي |قبل )?الساعه\\s*(\\d{1,2}|' + hw + ')(?:[:.](\\d{2})|\\s*و\\s*(نص|نصف|ربع))?\\s*(صباحا|الصبح|الصباح|ص|ظهرا|الظهر|عصرا|العصر|مساء|المساء|بالليل|م)?(?=\\s|$|[،,.:؛!])'));
    if (tm) {
      let h = HOURS[tm[1]] || Number(tm[1]); const mm = tm[2] ? Number(tm[2]) : tm[3] ? (tm[3] === 'ربع' ? 15 : 30) : 0; const q = tm[4] || '';
      if (/ظهر|عصر|مساء|ليل|^م$/.test(q) && h < 12) h += 12; else if (!q && h >= 1 && h <= 6) h += 12;
      if (h <= 23 && mm <= 59) { out.due_time = `${pad(h)}:${pad(mm)}`; out.found.push('time'); }
    }

    // الموعد
    const lead = '(?:^|\\s)(?:في |يوم |موعدها |الموعد |قبل |حتي |خلال |بحد اقصي |علي )*';
    const end = '(?=\\s|$|[،,.:؛!])';
    let m;
    if ((m = take(new RegExp(lead + '(?:بعد بكره|بعد بكرا|بعد غد|بعد الغد)' + end)))) out.due_date = add(today, 2);
    else if ((m = take(new RegExp(lead + '(?:اليوم|الحين|هذا اليوم)' + end)))) out.due_date = today;
    else if ((m = take(new RegExp(lead + '(?:غدا|غد|بكره|بكرا|باكر)' + end)))) out.due_date = add(today, 1);
    else if ((m = take(new RegExp(lead + 'بعد (\\d+|' + Object.keys(WORD_NUM).join('|') + ')? ?(يوم|ايام|يومين|اسبوع|اسابيع|اسبوعين|شهر|شهرين)' + end)))) {
      const unit = m[2]; let k = m[1] ? (Number(m[1]) || WORD_NUM[m[1]] || 1) : 1;
      if (unit === 'يومين' || unit === 'اسبوعين' || unit === 'شهرين') k = 2;
      out.due_date = add(today, /يوم|ايام/.test(unit) ? k : /اسبوع|اسابيع/.test(unit) ? 7 * k : 30 * k);
    } else if ((m = take(new RegExp(lead + '(?:الاسبوع (?:القادم|الجاي|المقبل)|الاسبوع الجاي)' + end)))) out.due_date = add(today, 7);
    else if ((m = take(new RegExp(lead + '(?:نهايه|اخر) (?:هذا )?الاسبوع' + end)))) { const k = (4 - dow(today) + 7) % 7; out.due_date = add(today, k); }
    else if ((m = take(new RegExp(lead + '(?:نهايه|اخر) (?:هذا )?الشهر' + end)))) { const d = new Date(today + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1, 0); out.due_date = iso(d); }
    else if ((m = take(new RegExp(lead + '(\\d{1,2}) ?(?:/|-| من )? ?(' + MONTHS.map(x => x[0]).join('|') + '|\\d{1,2})' + end)))) {
      const day = Number(m[1]); const mon = MONTHS.find(x => x[0] === m[2]); const month = mon ? mon[1] : Number(m[2]);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        let y = Number(today.slice(0, 4)); let cand = `${y}-${pad(month)}-${pad(day)}`;
        if (cand < today) cand = `${y + 1}-${pad(month)}-${pad(day)}`;
        out.due_date = cand;
      }
    } else {
      const wd = WEEKDAYS.map(x => x[0]).join('|');
      if ((m = take(new RegExp(lead + '(' + wd + ')(?: (?:القادم|الجاي|المقبل))?' + end)))) {
        const target = WEEKDAYS.find(x => x[0] === m[1])[1];
        let k = (target - dow(today) + 7) % 7; if (k === 0) k = 7;
        out.due_date = add(today, k);
      }
    }
    if (out.due_date) out.found.push('date');

    // المسؤول: موظف مسجّل يُذكر اسمه الكامل أو الأول، مع حروف الربط («لأحمد»، «إلى سارة»، «المسؤول فهد»)
    const people = (ctx.people || []).map(p => ({ ...p, full: norm(p.name).replace(/\s*\(.*?\)\s*/g, ' ').trim() })).filter(p => p.full);
    let best = null;
    for (const p of people) {
      const first = p.full.split(' ')[0];
      for (const cand of [p.full, first]) {
        if (cand.length < 3) continue;
        const re = new RegExp('(?:^|\\s)(?:(?:المسؤول|المسوول|مسؤولها|يتولاها|تتولاها|يتابعها|تتابعها|ويتولاها|وتتولاها|يكلف|تكلف|كلف|اسندها|اسند)\\s+)?(?:الي |لـ ?|ل|علي |مع )?' + cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$|[،,.:؛!])');
        const mm = norm(text).match(re);
        if (mm && (!best || cand.length > best.len)) best = { p, re, len: cand.length };
      }
    }
    if (best) { take(best.re); out.assignee_id = best.p.id; out.assignee_name = best.p.name; out.found.push('assignee'); }

    // القسم: «في قسم الجمعية» يُحذف من العنوان؛ أما ذكر اسم القسم داخل الكلام فيُستدل به دون حذفه
    const secs = (ctx.sections || []).map(s => ({ ...s, n: norm(s.name) }));
    for (const s of secs) {
      const re = new RegExp('(?:^|\\s)(?:في |ضمن |علي )?(?:قسم|مسار) ' + s.n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$|[،,.:؛!])');
      if (take(re)) { out.section = s.key; break; }
    }
    if (!out.section) for (const s of secs) if (new RegExp('(?:^|\\s)(?:و|ب|ل|لل)?' + s.n.replace(/^ال/, '(?:ال)?') + '(?=\\s|$|[،,.:؛!])').test(norm(text))) { out.section = s.key; break; }
    if (out.section) out.found.push('section');

    out.title = cleanEnds(text);
    if (out.title) out.title = out.title.charAt(0) + out.title.slice(1);
    return out;
  }
  // حروف ربط وعلامات معلقة في طرفي الجملة بعد حذف التفاصيل منها
  function cleanEnds(s) {
    let t = String(s || '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 4; i++) {
      t = t.replace(/^[\s،,.:؛\-–—]+|[\s،,.:؛\-–—]+$/g, '')
        .replace(/(?:^|\s)(?:و|ثم|على أن|علي ان|بحيث|ويكون|وتكون|يكون|تكون|في|الى|إلى|على|علي|مع|من|بخصوص|عن)$/u, '')
        .replace(/^(?:و|ثم)\s+/u, '').trim();
    }
    return t;
  }
  const api = { parseVoiceTask, norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VoiceTask = api;
})(typeof window !== 'undefined' ? window : globalThis);
