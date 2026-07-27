const PRINT_SHEET_PATTERN = /列印/;
const FEE_SHEET_PATTERN = /雜項/;
const DATE_BLOCK_WIDTH = 8;
const FEE_REFERENCE_COLUMN_INDEXES = [22, 23, 24];
const CUSTOM_FEE_START_INDEX = 29;
const SUBJECT_CODES = {
  數: "數學",
  英: "英文",
  理: "理化",
};

let workbookReader;

async function loadWorkbookReader() {
  if (!workbookReader) {
    const module = await import("read-excel-file/browser");
    workbookReader = module.default;
  }

  return workbookReader;
}

const cleanText = (value) =>
  String(value ?? "")
    .trim()
    .replaceAll("互動一校", "互動1校");

const isBlankMarker = (value) => {
  const text = cleanText(value);
  return !text || text === "*" || text === "/" || text.startsWith("#");
};

const pad = (value) => String(value).padStart(2, "0");

function formatDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(
      value.getUTCDate(),
    )}`;
  }

  const text = cleanText(value);
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);

  if (!match) {
    return "";
  }

  return `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
}

function toAmount(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const amount = Number(cleanText(value).replaceAll(",", ""));
  return Number.isFinite(amount) ? amount : 0;
}

function inferSubjectCode(label) {
  if (label.includes("理")) {
    return "理";
  }

  if (label.includes("英") || label.includes("口說")) {
    return "英";
  }

  if (label.includes("數")) {
    return "數";
  }

  return cleanText(label).slice(0, 1);
}

function normalizeSubjectLabel(code) {
  return SUBJECT_CODES[code] || code;
}

function isCourseHeader(value, index) {
  const label = cleanText(value);

  if (index < 4 || isBlankMarker(label)) {
    return false;
  }

  if (["數", "英", "理", "備註"].includes(label)) {
    return false;
  }

  return /[\u4e00-\u9fff]/.test(label);
}

function detectCourseBlocks(header) {
  return header
    .map((value, index) => ({ value: cleanText(value), index }))
    .filter(({ value, index }) => isCourseHeader(value, index))
    .map(({ value, index }) => ({
      id: `${inferSubjectCode(value)}-${index}`,
      start: index,
      end: index + DATE_BLOCK_WIDTH - 1,
      label: value,
      subjectCode: inferSubjectCode(value),
    }));
}

function makeStudentKey(studentNumber, studentName) {
  return `${studentNumber}-${studentName}`;
}

function columnLabel(index) {
  let value = index + 1;
  let label = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }

  return label;
}

function parseFeeSheet(rows) {
  return rows
    .map((row, index) => {
      const code = cleanText(row[0]);
      const rawName = cleanText(row[1]);
      const details = row
        .slice(3)
        .map((value, detailIndex) => ({
          column: columnLabel(detailIndex + 3),
          value: cleanText(value),
        }))
        .filter((item) => !isBlankMarker(item.value));

      return {
        id: `fee-row-${index + 1}`,
        rowNumber: index + 1,
        code,
        name: isBlankMarker(rawName) ? "條件 / 備註" : rawName,
        rawName,
        amount: toAmount(row[2]),
        details,
      };
    })
    .filter(
      (item) =>
        item.code &&
        !isBlankMarker(item.code) &&
        (!isBlankMarker(item.rawName) || item.details.length > 0),
    );
}

function addMapRecord(map, key, record) {
  if (!map.has(key)) {
    map.set(key, record);
  }

  return map.get(key);
}

function findFeeItem(feeItemsByCode, code) {
  return feeItemsByCode.get(cleanText(code));
}

function parseFeeReferences(row, header, feeItemsByCode) {
  return FEE_REFERENCE_COLUMN_INDEXES.map((columnIndex) => {
    const code = cleanText(row[columnIndex]);

    if (isBlankMarker(code) || code === "0") {
      return null;
    }

    const feeItem = findFeeItem(feeItemsByCode, code);

    return {
      id: `${columnLabel(columnIndex)}-${code}`,
      source: cleanText(header[columnIndex]) || columnLabel(columnIndex),
      code,
      name: feeItem?.name || `雜項代碼 ${code}`,
      amount: feeItem?.amount || 0,
      known: Boolean(feeItem),
      details: feeItem?.details || [],
    };
  }).filter(Boolean);
}

function parseCustomFees(row) {
  const customFees = [];

  for (let index = CUSTOM_FEE_START_INDEX; index < row.length; index += 2) {
    const name = cleanText(row[index]);
    const amount = toAmount(row[index + 1]);

    if (isBlankMarker(name) || amount === 0) {
      continue;
    }

    customFees.push({
      id: `${columnLabel(index)}-${customFees.length + 1}`,
      source: "自訂",
      code: "",
      name,
      amount,
      known: true,
      details: [],
    });
  }

  return customFees;
}

function estimateCourseTuition({ className, courseName, sessionCount, subjectCode }) {
  if (sessionCount <= 0) {
    return 0;
  }

  if (subjectCode === "理" || className.includes("理化")) {
    return sessionCount * 400;
  }

  if (courseName.includes("英檢")) {
    return sessionCount * 315;
  }

  return sessionCount * 275;
}

function parseClassSheet(
  sheetName,
  rows,
  studentsMap,
  enrollments,
  sessions,
  feeItemsByCode,
) {
  const header = rows[0] || [];
  const courseBlocks = detectCourseBlocks(header);
  const courseDateMap = new Map(
    courseBlocks.map((block) => [block.id, new Map()]),
  );
  const studentsInClass = new Set();
  const receivableDrafts = [];
  const feeDrafts = [];
  const studentRows = [];
  let sessionCount = 0;

  rows.slice(1).forEach((row, index) => {
    const studentNumber = cleanText(row[0]);
    const studentName = cleanText(row[1]);

    if (isBlankMarker(studentNumber) || isBlankMarker(studentName)) {
      return;
    }

    const studentKey = makeStudentKey(studentNumber, studentName);
    const rowNumber = index + 2;
    studentsInClass.add(studentKey);
    const student = addMapRecord(studentsMap, studentKey, {
      id: studentKey,
      studentNumber,
      name: studentName,
      sourceClasses: new Set(),
    });
    student.sourceClasses.add(sheetName.trim());

    const studentEnrollments = [];
    const studentCourseDates = {};

    courseBlocks.forEach((block) => {
      const classDates = row
        .slice(block.start, block.end + 1)
        .map(formatDate)
        .filter(Boolean);
      studentCourseDates[block.id] = classDates;
      classDates.forEach((date) => {
        const dateCount = courseDateMap.get(block.id).get(date) || 0;
        courseDateMap.get(block.id).set(date, dateCount + 1);
      });

      if (classDates.length === 0) {
        return;
      }

      const enrollmentId = `${sheetName}-${studentKey}-${block.subjectCode}`;
      studentEnrollments.push(enrollmentId);
      enrollments.set(enrollmentId, {
        id: enrollmentId,
        studentId: studentKey,
        studentName,
        studentNumber,
        className: sheetName.trim(),
        courseName: block.label,
        subjectCode: block.subjectCode,
        subjectName: normalizeSubjectLabel(block.subjectCode),
        sessionCount: classDates.length,
        tuitionAmount: estimateCourseTuition({
          className: sheetName.trim(),
          courseName: block.label,
          sessionCount: classDates.length,
          subjectCode: block.subjectCode,
        }),
      });

      classDates.forEach((date) => {
        sessions.push({
          id: `${enrollmentId}-${date}`,
          enrollmentId,
          studentId: studentKey,
          className: sheetName.trim(),
          courseName: block.label,
          date,
        });
      });

      sessionCount += classDates.length;
    });

    const feeReferences = parseFeeReferences(row, header, feeItemsByCode);
    const customFees = parseCustomFees(row);
    const studentFees = [...feeReferences, ...customFees];

    studentFees.forEach((fee, feeIndex) => {
      feeDrafts.push({
        ...fee,
        id: `${sheetName}-${studentKey}-fee-${fee.source || feeIndex}-${fee.code || feeIndex}`,
        studentId: studentKey,
        studentName,
        studentNumber,
        className: sheetName.trim(),
        rowNumber,
      });
    });

    studentRows.push({
      id: `${sheetName}-${studentKey}`,
      rowNumber,
      studentId: studentKey,
      studentNumber,
      studentName,
      subjects: [cleanText(row[2]), cleanText(row[3])].filter(
        (value) => !isBlankMarker(value),
      ),
      courseDates: studentCourseDates,
      feeReferences,
      customFees,
    });

    if (studentEnrollments.length > 0 || studentFees.length > 0) {
      receivableDrafts.push({
        id: `${sheetName}-${studentKey}-receivable`,
        studentId: studentKey,
        studentName,
        studentNumber,
        className: sheetName.trim(),
        enrollmentIds: studentEnrollments,
        feeCount: studentFees.length,
        status: "待確認",
      });
    }
  });

  const decoratedCourseBlocks = courseBlocks.map((block) => {
    const dateCounts = courseDateMap.get(block.id);
    const globalDates = [...dateCounts.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) {
          return b[1] - a[1];
        }

        return a[0].localeCompare(b[0]);
      })
      .slice(0, DATE_BLOCK_WIDTH)
      .map(([date]) => date)
      .sort();

    return {
      ...block,
      subjectName: normalizeSubjectLabel(block.subjectCode),
      globalDates,
      dateUsage: [...dateCounts.entries()].map(([date, count]) => ({
        date,
        count,
      })),
    };
  });

  return {
    id: sheetName.trim(),
    name: sheetName.trim(),
    courseLabels: courseBlocks.map((block) => block.label),
    courseBlocks: decoratedCourseBlocks,
    studentRows,
    studentCount: studentsInClass.size,
    enrollmentCount: [...enrollments.values()].filter(
      (enrollment) => enrollment.className === sheetName.trim(),
    ).length,
    sessionCount,
    feeDrafts,
    receivableDrafts,
  };
}

export async function organizeTuitionBagFile(file) {
  const readWorkbook = await loadWorkbookReader();
  const workbookSheets = await readWorkbook(file);
  const sheetRecords = workbookSheets.map(({ sheet: sheetName, data: rows }) => ({
    sheetName,
    trimmedName: sheetName.trim(),
    rows,
  }));
  const studentsMap = new Map();
  const enrollments = new Map();
  const sessions = [];
  const feeItems = [];
  const printSheets = [];
  const ignoredSheets = [];
  const classSheets = [];
  const receivableDrafts = [];
  const feeDrafts = [];

  sheetRecords.forEach(({ sheetName, rows }) => {
    if (FEE_SHEET_PATTERN.test(sheetName)) {
      feeItems.push(...parseFeeSheet(rows));
    }
  });

  const feeItemsByCode = new Map(feeItems.map((item) => [item.code, item]));

  sheetRecords.forEach(({ sheetName, trimmedName, rows }) => {
    if (PRINT_SHEET_PATTERN.test(sheetName)) {
      printSheets.push(trimmedName);
      return;
    }

    if (FEE_SHEET_PATTERN.test(sheetName)) {
      return;
    }

    if (!rows.length || cleanText(rows[0]?.[0]) !== "編號") {
      ignoredSheets.push(trimmedName);
      return;
    }

    const parsedClass = parseClassSheet(
      sheetName,
      rows,
      studentsMap,
      enrollments,
      sessions,
      feeItemsByCode,
    );

    classSheets.push(parsedClass);
    receivableDrafts.push(...parsedClass.receivableDrafts);
    feeDrafts.push(...parsedClass.feeDrafts);
  });

  const students = [...studentsMap.values()].map((student) => ({
    ...student,
    sourceClasses: [...student.sourceClasses],
  }));

  return {
    fileName: file.name,
    fileSize: file.size,
    detectedAt: new Date().toISOString(),
    summary: {
      totalSheets: workbookSheets.length,
      classSheetCount: classSheets.length,
      printSheetCount: printSheets.length,
      ignoredSheetCount: ignoredSheets.length,
      studentCount: students.length,
      enrollmentCount: enrollments.size,
      sessionCount: sessions.length,
      feeItemCount: feeItems.length,
      feeDraftCount: feeDrafts.length,
      receivableDraftCount: receivableDrafts.length,
    },
    classSheets,
    printSheets,
    ignoredSheets,
    students,
    enrollments: [...enrollments.values()],
    sessions,
    feeItems,
    feeDrafts,
    receivableDrafts,
  };
}
