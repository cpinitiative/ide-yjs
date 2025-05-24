const { createLogger, format, transports } = require("winston");
const path = require("path");

const logger = createLogger({
  level: "info",
  exitOnError: false,
  format: format.combine(format.timestamp(), format.json()),
  transports: [
    new transports.Console(),
    new transports.File({
      filename: path.join(__dirname, "../logs/ideyjs.log"),
    }),
  ],
});

export default logger;
