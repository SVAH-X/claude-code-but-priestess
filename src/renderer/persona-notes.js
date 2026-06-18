const notesEl = document.getElementById("notes");
const counterEl = document.getElementById("counter");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("saveBtn");
const cancelBtn = document.getElementById("cancelBtn");
const clearBtn = document.getElementById("clearBtn");

const MAX = 1500;

function updateCounter() {
  const len = notesEl.value.length;
  counterEl.textContent = `${len} / ${MAX}`;
  counterEl.className = len > MAX * 0.9 ? "counter warn" : "counter";
}

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = kind || "";
}

window.personaNotesApi.get().then((notes) => {
  notesEl.value = notes || "";
  updateCounter();
}).catch(() => setStatus("读取失败", "err"));

notesEl.addEventListener("input", () => {
  updateCounter();
  setStatus("");
});

clearBtn.addEventListener("click", () => {
  notesEl.value = "";
  updateCounter();
  setStatus("");
  notesEl.focus();
});

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  try {
    await window.personaNotesApi.set(notesEl.value);
    setStatus("已保存", "ok");
    setTimeout(() => window.personaNotesApi.close(), 400);
  } catch (error) {
    setStatus(`保存失败：${error?.message || error}`, "err");
    saveBtn.disabled = false;
  }
});

cancelBtn.addEventListener("click", () => window.personaNotesApi.close());
