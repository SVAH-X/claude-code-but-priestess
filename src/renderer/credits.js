const UI = {
  zh: {
    title: "制作者名单",
    intro: "按第一次贡献的先后顺序排列。感谢每一位让普瑞赛斯走到这里的人。",
    meta: (v) => `PRTS v${v}`,
    close: "关闭"
  },
  en: {
    title: "Contributors",
    intro: "Listed in order of first contribution. Thanks to everyone who brought Priestess this far.",
    meta: (v) => `PRTS v${v}`,
    close: "Close"
  }
};

const titleEl = document.getElementById("title");
const introEl = document.getElementById("intro");
const listEl = document.getElementById("list");
const metaEl = document.getElementById("meta");
const closeBtn = document.getElementById("closeBtn");

function renderPerson(person, lang) {
  const card = document.createElement("div");
  card.className = "person" + (person.name === "-浅蓝笑" ? " artist" : "");

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = person.name;
  card.appendChild(name);

  const role = document.createElement("div");
  role.className = "role";
  role.textContent = (person.role && (person.role[lang] || person.role.en)) || "";
  card.appendChild(role);

  if (Array.isArray(person.links) && person.links.length) {
    const links = document.createElement("div");
    links.className = "links";
    for (const link of person.links) {
      const chip = document.createElement("span");
      if (link.url) {
        chip.className = "chip";
        chip.textContent = link.label;
        chip.addEventListener("click", () => window.creditsApi.openLink(link.url));
      } else {
        chip.className = "chip static";
        chip.textContent = link.label;
      }
      links.appendChild(chip);
    }
    card.appendChild(links);
  }

  return card;
}

window.creditsApi
  .get()
  .then((data) => {
    const lang = data?.lang === "zh" ? "zh" : "en";
    const text = UI[lang];
    titleEl.textContent = text.title;
    introEl.textContent = text.intro;
    metaEl.textContent = text.meta(data?.appVersion || "");
    closeBtn.textContent = text.close;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = `PRTS · ${text.title}`;

    listEl.replaceChildren(
      ...(data?.contributors || []).map((person) => renderPerson(person, lang))
    );
  })
  .catch((error) => {
    introEl.textContent = String(error?.message || error);
  });

closeBtn.addEventListener("click", () => window.creditsApi.close());
