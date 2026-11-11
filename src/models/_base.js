// Shared schema options: string ids and createdAt/updatedAt.
const mongoose = require("mongoose");

const newId = () => new mongoose.Types.ObjectId().toString();

// Every record is sent to the browser with its "_id" (same as in MongoDB)
const options = { timestamps: true, versionKey: false };

module.exports = { mongoose, Schema: mongoose.Schema, Mixed: mongoose.Schema.Types.Mixed, newId, options };
