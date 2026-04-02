import { google } from 'googleapis';

// ID de tu Google Sheet (está en la URL: /spreadsheets/d/ESTE_ID/edit)
const SHEET_ID  = process.env.GOOGLE_SHEET_ID || '1Pr-rxpZBXpZuVUhOOHpGriT1MeItKqgZ4symUeCRTbc';
const SHEET_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQGBZ172IdFEj878LM9tr_Vyt2wGzsKS8JVB8mfuHDSsUe7m7QFrjl9i9olCPyi321X1EtygH7l5PKn/pub?gid=0&single=true&output=csv';
const SHEET_TAB = 'Nutricion'; // nombre de la pestaña

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// Agrega una fila al final de la hoja
export async function appendToSheet(row) {
  const sheets = getSheets();

  const values = [[
    row.fecha,
    row.hora,
    row.comida,
    row.alimento,
    row.gramos,
    row.kcal,
    row.proteina,
    row.carbos,
    row.grasas,
    row.agua_ml,
    row.fase_ciclo,
    row.energia,
    row.sueno_h,
    row.nota,
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:N`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

// Lee todas las filas de hoy y suma los macros
export async function getDailySummary() {
  const sheets = getSheets();
  const today  = new Date().toLocaleDateString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit' });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:N`,
  });

  const rows = res.data.values || [];

  const todayRows = rows.filter(r => r[0] === today && r[5]); // filtra por fecha y que tenga kcal

  return todayRows.reduce((acc, r) => ({
    kcal:     acc.kcal     + (parseFloat(r[5])  || 0),
    proteina: acc.proteina + (parseFloat(r[6])  || 0),
    carbos:   acc.carbos   + (parseFloat(r[7])  || 0),
    grasas:   acc.grasas   + (parseFloat(r[8])  || 0),
    agua:     acc.agua     + (parseFloat(r[9])  || 0),
  }), { kcal: 0, proteina: 0, carbos: 0, grasas: 0, agua: 0 });
}
