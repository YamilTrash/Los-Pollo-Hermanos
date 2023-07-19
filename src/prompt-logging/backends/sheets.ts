import { google, sheets_v4 } from "googleapis";
import type { CredentialBody } from "google-auth-library";
import type { GaxiosResponse } from "googleapis-common";
import { config } from "../../config";
import { logger } from "../../logger";
import { PromptLogEntry } from "..";
import randomWords from "random-words";

type IndexSheetModel = {
  lockId: string;
  rows: { logSheetName: string; createdAt: string; rowCount: number }[];
};

type LogSheetModel = {
  sheetName: string;
  rows: {
    id: string;
    value: number;
    model: string;
    endpoint: string;
    promptRaw: string;
    promptFlattened: string;
    response: string;
  }[];
};

const MAX_ROWS_PER_SHEET = 2000;
const log = logger.child({ module: "sheets" });

let sheetsClient: sheets_v4.Sheets | null = null;
let stopCallback: (() => void) | null = null;
let lockId = Math.random().toString(36).substring(2, 15);
let indexSheet: IndexSheetModel | null = null;
let activeLogSheet: LogSheetModel | null = null;

const assignUniqueIds = (logSheet: LogSheetModel) => {
  const idMap: { [key: string]: { id: string; value: number } } = {};

  for (const row of logSheet.rows) {
    const promptFlattened = row.promptFlattened;
    let id = idMap[promptFlattened]?.id;

    if (!id) {
      id = generateRandomWord();
      idMap[promptFlattened] = { id, value: 1 };
    }

    row.id = id;
    row.value = idMap[promptFlattened].value;
    idMap[promptFlattened].value++;
  }
};

const generateRandomWord = (): string => {
  return randomWords();
};

const loadIndexSheet = async (assertLockId = true) => {
  const client = sheetsClient!;
  const spreadsheetId = config.googleSheetsSpreadsheetId!;
  log.info({ assertLockId }, "Loading __index__ sheet.");
  const res = await client.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: "__index__!A1:D",
    majorDimension: "ROWS",
  });
  const data = assertData(res);
  if (!data.values || data.values[2][0] !== "logSheetName") {
    log.error({ values: data.values }, "Unexpected format for __index__ sheet");
    throw new Error("Unexpected format for __index__ sheet");
  }

  if (assertLockId) {
    const lockIdCell = data.values[1][1];
    if (lockIdCell !== lockId) {
      log.error(
        { receivedLock: lockIdCell, expectedLock: lockId },
        "Another instance of the proxy is writing to the spreadsheet; stopping."
      );
      stop();
      throw new Error(`Lock ID assertion failed`);
    }
  }

  const rows = data.values.slice(3).map((row) => {
    return {
      logSheetName: row[0],
      createdAt: row[1],
      rowCount: row[2],
    };
  });
  indexSheet = { lockId, rows };
};

const createLogSheet = async () => {
  const client = sheetsClient!;
  const spreadsheetId = config.googleSheetsSpreadsheetId!;
  const sheetName = `Log_${new Date()
    .toISOString()
    .replace(/[-:.]/g, "")
    .replace(/T/, "_")
    .substring(0, 15)}`;

  log.info({ sheetName }, "Creating new log sheet.");
  const res = await client.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetName,
              gridProperties: { rowCount: MAX_ROWS_PER_SHEET, columnCount: 6 },
            },
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 0,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 6,
            },
            rows: [
              {
                values: [
                  {
                    userEnteredValue: { stringValue: "UniqueID" },
                  },
                  {
                    userEnteredValue: { stringValue: "model" },
                  },
                  {
                    userEnteredValue: { stringValue: "endpoint" },
                  },
                  {
                    userEnteredValue: { stringValue: "prompt json" },
                  },
                  {
                    userEnteredValue: { stringValue: "prompt string" },
                  },
                  {
                    userEnteredValue: { stringValue: "response" },
                  },
                ],
              },
            ],
            fields: "userEnteredValue",
          },
        },
      ],
    },
  });
  assertData(res);

  const sheetId = res.data.replies![0].addSheet!.properties!.sheetId;
  await client.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId },
            cell: {
              userEnteredFormat: {
                wrapStrategy: "WRAP",
                verticalAlignment: "TOP",
              },
            },
            fields: "*",
          },
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 3,
              endIndex: 5,
            },
            properties: { pixelSize: 500 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: 1,
            },
            properties: { pixelSize: 200 },
            fields: "pixelSize",
          },
        },
      ],
    },
  });
  await client.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        {
          range: `${sheetName}!A1:F`,
          values: [
            ["UniqueID", "model", "endpoint", "prompt json", "prompt string", "response"],
          ],
        },
      ],
    },
  });
  indexSheet!.rows.push({
    logSheetName: sheetName,
    createdAt: new Date().toISOString(),
    rowCount: 0,
  });
  await writeIndexSheet();
  activeLogSheet = { sheetName, rows: [] };
};

export const appendBatch = async (batch: PromptLogEntry[]) => {
  if (!activeLogSheet) {
    await createLogSheet();
  } else {
    await loadIndexSheet(true);
  }

  const client = sheetsClient!;
  const spreadsheetId = config.googleSheetsSpreadsheetId!;
  const sheetName = activeLogSheet!.sheetName;
  const newRows = batch.map((entry) => {
    return [
      entry.model,
      entry.endpoint,
      entry.promptRaw.slice(0, 50000),
      entry.promptFlattened.slice(0, 50000),
      entry.response.slice(0, 50000),
    ];
  });
  log.info({ sheetName, rowCount: newRows.length }, "Appending log batch.");
  const data = await client.spreadsheets.values.append({
    spreadsheetId: spreadsheetId,
    range: `${sheetName}!A1:D`,
    valueInputOption: "RAW",
    requestBody: { values: newRows, majorDimension: "ROWS" },
  });
  assertData(data);
  if (data.data.updates && data.data.updates.updatedRows) {
    const newRowCount = data.data.updates.updatedRows;
    log.info({ sheetName, rowCount: newRowCount }, "Successfully appended.");
    activeLogSheet!.rows = activeLogSheet!.rows.concat(
      newRows.map((row) => ({
        id: row[0],
        value: 0,
        model: row[1],
        endpoint: row[2],
        promptRaw: row[3],
        promptFlattened: row[4],
        response: row[5],
      }))
    );
  } else {
    log.warn(
      { sheetName, rowCount: newRows.length },
      "No updates received from append. Creating new sheet and retrying."
    );
    await createLogSheet();
    throw new Error("No updates received from append.");
  }
  await finalizeBatch();
};

const finalizeBatch = async () => {
  const sheetName = activeLogSheet!.sheetName;
  const rowCount = activeLogSheet!.rows.length;
  const indexRow = indexSheet!.rows.find(
    ({ logSheetName }) => logSheetName === sheetName
  )!;
  indexRow.rowCount = rowCount;
  if (rowCount >= MAX_ROWS_PER_SHEET) {
    await createLogSheet();
  } else {
    await writeIndexSheet();
  }
  log.info({ sheetName, rowCount }, "Batch finalized.");
};

type LoadLogSheetArgs = {
  sheetName: string;
  fromRow?: number;
};

export const loadLogSheet = async ({
  sheetName,
  fromRow = 2,
}: LoadLogSheetArgs) => {
  const client = sheetsClient!;
  const spreadsheetId = config.googleSheetsSpreadsheetId!;

  const range = `${sheetName}!A${fromRow}:E`;
  const res = await client.spreadsheets.values.get({
    spreadsheetIdrange,
  });
  const data = assertData(res);
  const values = data.values || [];
  const rows = values.slice(1).map((row) => {
    return {
      model: row[0],
      endpoint: row[1],
      promptRaw: row[2],
      promptFlattened: row[3],
      response: row[4],
    };
  });
  activeLogSheet = { sheetName, rows };
};

export const init = async (onStop: () => void) => {
  if (sheetsClient) {
    return;
  }
  if (!config.googleSheetsKey || !config.googleSheetsSpreadsheetId) {
    throw new Error(
      "Missing required Google Sheets config. Refer to documentation for setup instructions."
    );
  }

  log.info("Initializing Google Sheets backend.");
  const encodedCreds = config.googleSheetsKey;
  const creds: CredentialBody = JSON.parse(
    Buffer.from(encodedCreds, "base64").toString("utf8").trim()
  );
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    credentials: creds,
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  stopCallback = onStop;

  const sheetId = config.googleSheetsSpreadsheetId;
  const res = await sheetsClient.spreadsheets.get({
    spreadsheetId: sheetId,
  });
  if (!res.data) {
    const { status, statusText, headers } = res;
    log.error(
      {
        res: { status, statusText, headers },
        creds: {
          client_email: creds.client_email?.slice(0, 5) + "********",
          private_key: creds.private_key?.slice(0, 5) + "********",
        },
        sheetId: config.googleSheetsSpreadsheetId,
      },
      "Could not connect to Google Sheets."
    );
    stop();
    throw new Error("Could not connect to Google Sheets.");
  } else {
    const sheetTitle = res.data.properties?.title;
    log.info({ sheetId, sheetTitle }, "Connected to Google Sheets.");
  }

  try {
    log.info("Loading index sheet.");
    await loadIndexSheet(false);
    await writeIndexSheet();
  } catch (e) {
    log.info("Creating new index sheet.");
    await createIndexSheet();
  }
};

function stop() {
  log.warn("Stopping Google Sheets backend.");
  if (stopCallback) {
    stopCallback();
  }
  sheetsClient = null;
}

function assertData<T = sheets_v4.Schema$ValueRange>(res: GaxiosResponse<T>) {
  if (!res.data) {
    const { status, statusText, headers } = res;
    log.error(
      { res: { status, statusText, headers } },
      "Unexpected response from Google Sheets API."
    );
  }
  return res.data!;
}
