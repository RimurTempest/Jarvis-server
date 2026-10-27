"use strict";
function taskId(s) { if (typeof s !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) throw Error("UUID inválido"); return s.toLowerCase(); }
module.exports={taskId};
