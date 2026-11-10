// Streamline Auto Collision: the estimate forms and the before-and-after sliders.

// ---------- estimate forms (Netlify Forms; files go up as multipart, so no Content-Type header) ----------
const MAX_BYTES = 7.5 * 1024 * 1024; // Netlify takes 8 MB a submission

async function shrinkPhoto(file) {
  if (!file || !file.size || !file.type.startsWith('image/') || file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.82));
    return blob ? new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file; // a format this browser cannot draw: send it as it is
  }
}

document.querySelectorAll('form[data-estimate]').forEach((form) => {
  const status = form.querySelector('[role="status"]');
  const button = form.querySelector('button[type="submit"]');
  const say = (text, tone) => { status.textContent = text; status.dataset.tone = tone || ''; };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    const invalid = [...form.elements].filter((el) => el.willValidate && !el.checkValidity());
    if (invalid.length) {
      invalid.forEach((el) => el.setAttribute('aria-invalid', 'true'));
      const first = invalid[0];
      const what = first.name === 'shop' ? 'which shop to send it to' : first.name === 'phone' ? 'a phone number we can call' : 'your name';
      say('Add ' + what + ', then send again.', 'error');
      first.focus();
      return;
    }

    const data = new FormData(form);
    const photo = data.get('photo');
    if (photo && photo.size) {
      const smaller = await shrinkPhoto(photo);
      if (smaller.size > MAX_BYTES) {
        say('That photo is too large to send. Pick a smaller one, or send the form without it.', 'error');
        form.querySelector('input[type="file"]').focus();
        return;
      }
      data.set('photo', smaller, smaller.name);
    }

    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    say('Sending…');
    try {
      const response = await fetch(form.getAttribute('action') || '/', { method: 'POST', body: data });
      if (!response.ok) throw new Error(String(response.status));
      const shop = data.get('shop') || '';
      form.reset();
      say('Sent. Your request is with the ' + shop.split(',')[0] + ' shop.');
    } catch {
      say('That did not go through. Call Central at (915) 300-2311 or East at (915) 593-7100.', 'error');
    } finally {
      button.removeAttribute('aria-busy');
      button.disabled = false;
    }
  });
});

// ---------- before and after: list the pairs in data-ba-pairs ("1 2") once images/before-N.jpg and images/after-N.jpg exist ----------
const load = (src) => new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = src; });

document.querySelectorAll('[data-ba-pairs]').forEach(async (band) => {
  const list = band.querySelector('[data-ba-list]');
  const pairs = (band.dataset.baPairs || '').split(/\s+/).filter(Boolean);
  for (const n of pairs) {
    try {
      const [before, after] = await Promise.all([load(`images/before-${n}.jpg`), load(`images/after-${n}.jpg`)]);
      const figure = document.createElement('figure');
      figure.className = 'ba';
      before.alt = `Repair ${n}, before`;
      after.alt = `Repair ${n}, after`;
      after.className = 'ba__after';
      const line = document.createElement('span');
      line.className = 'ba__line';
      const range = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 100, value: 50 });
      range.setAttribute('aria-label', `Repair ${n}: slide to compare before and after`);
      range.addEventListener('input', () => figure.style.setProperty('--pos', range.value + '%'));
      const caption = document.createElement('figcaption');
      caption.innerHTML = '<span>Before</span><span>After</span>';
      figure.append(before, after, line, range, caption);
      list.append(figure);
      band.dataset.hasPairs = '';
    } catch {
      // that pair's files are not there yet
    }
  }
});
