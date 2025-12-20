const fs = require("fs");

const json = fs.readFileSync("./serviceAccount.json", "utf8");
const base64 = Buffer.from(json).toString("base64");
console.log(base64);
