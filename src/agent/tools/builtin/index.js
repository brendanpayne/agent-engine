// The built-in tool set. Domain-neutral by design — nothing here assumes a
// particular application. Host applications register their own tools alongside
// these, or omit these entirely and register only their own.

const { webSearch, fetchPage } = require("./web");
const { lookupKb, proposeKbEntry } = require("./knowledge");
const { searchHistory, recallEpisode } = require("./recall");
const { generateImage } = require("./media");
const { setReminder } = require("./reminders");
const { setDirective, removeDirective } = require("./directives");

const BUILTIN_TOOLS = [
  webSearch,
  fetchPage,
  lookupKb,
  proposeKbEntry,
  searchHistory,
  recallEpisode,
  generateImage,
  setReminder,
  setDirective,
  removeDirective,
];

module.exports = {
  BUILTIN_TOOLS,
  webSearch, fetchPage, lookupKb, proposeKbEntry,
  searchHistory, recallEpisode, generateImage, setReminder,
  setDirective, removeDirective,
};
