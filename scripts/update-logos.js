const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "../data/store.json");
if (!fs.existsSync(file)) {
  console.log("No store.json file found.");
  process.exit(0);
}

const store = JSON.parse(fs.readFileSync(file, "utf8"));

const logoMap = [
  { key: "bangla vision", url: "https://upload.wikimedia.org/wikipedia/en/thumb/1/1d/Banglavision.svg/330px-Banglavision.svg.png" },
  { key: "banglavision", url: "https://upload.wikimedia.org/wikipedia/en/thumb/1/1d/Banglavision.svg/330px-Banglavision.svg.png" },
  { key: "maasranga", url: "https://upload.wikimedia.org/wikipedia/en/3/39/Maasranga_Television_Logo.jpg" },
  { key: "rtv", url: "https://upload.wikimedia.org/wikipedia/en/thumb/4/4e/Rtv_bangladesh.svg/330px-Rtv_bangladesh.svg.png" },
  { key: "somoy", url: "https://upload.wikimedia.org/wikipedia/en/thumb/c/c4/SOMOY_TV_Logo.svg/330px-SOMOY_TV_Logo.svg.png" },
  { key: "dbc", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/%E0%A6%A1%E0%A6%BF%E0%A6%AC%E0%A6%BF%E0%A6%B8%E0%A6%BF_%E0%A6%A8%E0%A6%BF%E0%A6%89%E0%A6%9C%E2%80%93%E0%A6%8F%E0%A6%B0_%E0%A6%B2%E0%A7%8B%E0%A6%97%E0%A7%8B.svg/330px-%E0%A6%A1%E0%A6%BF%E0%A6%AC%E0%A6%BF%E0%A6%B8%E0%A6%BF_%E0%A6%A8%E0%A6%BF%E0%A6%89%E0%A6%9C%E2%80%93%E0%A6%8F%E0%A6%B0_%E0%A6%B2%E0%A7%8B%E0%A6%97%E0%A7%8B.svg.png" },
  { key: "duronto", url: "https://upload.wikimedia.org/wikipedia/en/d/d7/Duronto_TV_Logo.png" },
  { key: "ntv", url: "https://upload.wikimedia.org/wikipedia/en/thumb/e/ef/NTV_%28Bangladesh%29_logo.svg/330px-NTV_%28Bangladesh%29_logo.svg.png" },
  { key: "atn bangla", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/95/ATN_Bangla_Logo_without_slogan.svg/330px-ATN_Bangla_Logo_without_slogan.svg.png" },
  { key: "atn music", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/95/ATN_Bangla_Logo_without_slogan.svg/330px-ATN_Bangla_Logo_without_slogan.svg.png" },
  { key: "atn", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/95/ATN_Bangla_Logo_without_slogan.svg/330px-ATN_Bangla_Logo_without_slogan.svg.png" },
  { key: "ekushey", url: "https://upload.wikimedia.org/wikipedia/en/thumb/d/d9/Ekushey_Television_Logo.svg/330px-Ekushey_Television_Logo.svg.png" },
  { key: "etv", url: "https://upload.wikimedia.org/wikipedia/en/thumb/d/d9/Ekushey_Television_Logo.svg/330px-Ekushey_Television_Logo.svg.png" },
  { key: "gtv", url: "https://upload.wikimedia.org/wikipedia/en/thumb/f/f1/Logo_of_GTV_%28Bangladesh%29.svg/330px-Logo_of_GTV_%28Bangladesh%29.svg.png" },
  { key: "gazi", url: "https://upload.wikimedia.org/wikipedia/en/thumb/f/f1/Logo_of_GTV_%28Bangladesh%29.svg/330px-Logo_of_GTV_%28Bangladesh%29.svg.png" },
  { key: "t sports", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/T_Sports_logo.svg/330px-T_Sports_logo.svg.png" },
  { key: "tsports", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/T_Sports_logo.svg/330px-T_Sports_logo.svg.png" },
  { key: "channel 24", url: "https://upload.wikimedia.org/wikipedia/en/thumb/9/9b/Logo_of_Channel_24_%28Bangladesh%29.svg/330px-Logo_of_Channel_24_%28Bangladesh%29.svg.png" },
  { key: "independent", url: "https://upload.wikimedia.org/wikipedia/en/thumb/c/c1/Independent_Television_Logo.svg/330px-Independent_Television_Logo.svg.png" },
  { key: "boishakhi", url: "https://upload.wikimedia.org/wikipedia/en/thumb/c/c7/Boishakhi_TV_logo.svg/330px-Boishakhi_TV_logo.svg.png" },
  { key: "channel i", url: "https://upload.wikimedia.org/wikipedia/en/thumb/8/88/Channel-i.svg/330px-Channel-i.svg.png" },
  { key: "deepto", url: "https://upload.wikimedia.org/wikipedia/en/thumb/0/00/Logo_of_Deepto_TV.svg/330px-Logo_of_Deepto_TV.svg.png" },
  { key: "btv", url: "https://upload.wikimedia.org/wikipedia/en/thumb/0/02/Bangladesh_Television_Logo.svg/330px-Bangladesh_Television_Logo.svg.png" },
  { key: "news 21", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/%E0%A6%A1%E0%A6%BF%E0%A6%AC%E0%A6%BF%E0%A6%B8%E0%A6%BF_%E0%A6%A8%E0%A6%BF%E0%A6%89%E0%A6%9C%E2%80%93%E0%A6%8F%E0%A6%B0_%E0%A6%B2%E0%A7%8B%E0%A6%97%E0%A7%8B.svg/330px-%E0%A6%A1%E0%A6%BF%E0%A6%AC%E0%A6%BF%E0%A6%B8%E0%A6%BF_%E0%A6%A8%E0%A6%BF%E0%A6%89%E0%A6%9C%E2%80%93%E0%A6%8F%E0%A6%B0_%E0%A6%B2%E0%A7%8B%E0%A6%97%E0%A7%8B.svg.png" },
  { key: "star sports", url: "https://upload.wikimedia.org/wikipedia/en/2/22/Star_Sports_Network_logo.png" },
  { key: "sony", url: "https://upload.wikimedia.org/wikipedia/en/thumb/c/cd/Sony_Sports_Network.svg/330px-Sony_Sports_Network.svg.png" },
  { key: "aaj tak", url: "https://upload.wikimedia.org/wikipedia/en/thumb/7/77/Aaj_Tak_logo.svg/330px-Aaj_Tak_logo.svg.png" },
  { key: "ptv sports", url: "https://upload.wikimedia.org/wikipedia/en/e/e4/PTV_Sports.png" },
  { key: "geo news", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f7/GEO_News_logo_in_Urdu.png/330px-GEO_News_logo_in_Urdu.png" },
];

let updatedCount = 0;
store.channels.forEach((c) => {
  const lower = c.name.toLowerCase();
  let matched = false;
  for (const item of logoMap) {
    if (lower.includes(item.key)) {
      c.logo = item.url;
      matched = true;
      updatedCount++;
      break;
    }
  }
  if (!matched) {
    c.logo = `https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&background=0284c7&color=ffffff&size=256&bold=true&font-size=0.3&rounded=true`;
  }
});

fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
console.log(`Successfully updated ${updatedCount} channel logos in store.json`);
