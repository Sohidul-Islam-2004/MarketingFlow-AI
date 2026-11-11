// One place to import every model: const { Order, Product } = require("../models");
module.exports = {
  Organization: require("./Organization"),
  User: require("./User"),
  Session: require("./Session"),
  Product: require("./Product"),
  StockMovement: require("./StockMovement"),
  Order: require("./Order"),
  Counter: require("./Counter"),
  Blacklist: require("./Blacklist"),
  Conversation: require("./Conversation"),
  Comment: require("./Comment"),
  SocialAccount: require("./SocialAccount"),
  ContentItem: require("./ContentItem"),
  MediaAsset: require("./MediaAsset"),
  Notification: require("./Notification"),
  ProcessedEvent: require("./ProcessedEvent"),
};
