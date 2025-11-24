// ------------------ Imports ------------------
const express = require("express");
const path = require("path");
const { exec } = require("child_process");
const bodyParser = require("body-parser");
const multer = require("multer");
const bcrypt = require("bcrypt");         // for password hashing
const pool = require("./db");             // ✅ MySQL pool
const authRoutes = require("./auth");     // ✅ auth routes
require("dotenv").config();

// ------------------ App Setup ------------------
const app = express();
const PORT = 5000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public"))); // serve HTML/CSS/JS

// ------------------ File Upload Config ------------------
const UPLOAD_PATH = path.join(__dirname, "test_images");
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_PATH),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// ------------------ Routes ------------------

// ✅ Auth routes
app.use("/auth", authRoutes);

// ✅ Emergency route with YOLO prediction
app.post("/emergency/submit", upload.single("injuryImage"), (req, res) => {
  try {
    const { reportingFor, emergencyType, patientName, mobile, bloodGroup, ambulance } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const imagePath = path.join(UPLOAD_PATH, req.file.filename);
    const pythonScript = path.join(__dirname, "predict.py");

    console.log("Processing image:", imagePath);

    exec(`python "${pythonScript}" "${imagePath}"`, async (err, stdout, stderr) => {
      if (err) {
        console.error("Python error:", err);
        return res.status(500).json({ message: "Prediction failed" });
      }

      // ✅ FIX: Safely extract JSON from Python output
      let prediction = "No result";
      try {
        // Your Python should print something like {"injuryResult":"major injury"}
        const match = stdout.match(/\{.*\}/s);
        if (match) {
          const pyOutput = JSON.parse(match[0]);
          if (pyOutput && pyOutput.injuryResult) {
            prediction = pyOutput.injuryResult;
          }
        } else {
          console.warn("⚠️ No JSON block in Python output:", stdout);
        }
      } catch (parseErr) {
        console.error("JSON parse error:", parseErr, "\nRaw stdout:", stdout);
      }

      // ✅ Insert into MySQL
      try {
        await pool.query(
          `INSERT INTO emergency_reports
           (reportingFor, emergencyType, patientName, mobile, bloodGroup, ambulance, imageName, detection)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            reportingFor || null,
            emergencyType || null,
            patientName || null,
            mobile || null,
            bloodGroup || null,
            ambulance || null,
            req.file.filename,
            prediction
          ]
        );
      } catch (dbErr) {
        console.error("MySQL insert error:", dbErr);
        return res.status(500).json({ message: "Database insert failed" });
      }

      // ✅ Respond to frontend
      return res.json({
        message: "✅ Emergency submitted successfully!",
        uploadedFile: req.file.filename,
        detection: prediction
      });
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ✅ Hospital Registration
app.post("/register", async (req, res) => {
  try {
    const data = req.body;
    console.log("📥 Incoming registration:", data);

    // Required fields
    if (!data.hospitalName || !data.username || !data.password) {
      return res.status(400).json({
        message: "Hospital Name, Username, and Password are required."
      });
    }

    // Check if username exists
    const [existing] = await pool.query(
      "SELECT id FROM hospitals WHERE username = ?",
      [data.username]
    );
    if (existing.length > 0) {
      return res.status(400).json({ message: "Username already exists." });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(data.password, 10);

    // Insert query (added longitude & latitude)
    const insertQuery = `
      INSERT INTO hospitals 
      (hospitalName, hospitalType, license, estYear, hospitalEmail, username, password,
      address, city, state, pin, phone, website,
      totalBeds, icuBeds, ventilators, ambulances, doctors, nurses, departments,
      longitude, latitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

const params = [
  data.hospitalName,
  data.hospitalType || null,
  data.license || null,
  data.estYear || null,
  data.hospitalEmail || null,
  data.username,
  hashedPassword,
  data.address || null,
  data.city || null,
  data.state || null,
  data.pin || null,
  data.phone || null,
  data.website || null,
  Number(data.totalBeds) || 0,
  Number(data.icuBeds) || 0,
  Number(data.ventilators) || 0,
  Number(data.ambulances) || 0, // <-- fix here
  Number(data.doctors) || 0,
  Number(data.nurses) || 0,
  JSON.stringify(data.departments || []),
  data.longitude || null,
  data.latitude || null
];


    try {
      await pool.query(insertQuery, params);
      console.log("✅ Hospital inserted successfully");
      return res.status(200).json({ message: "Hospital registered successfully!" });
    } catch (dbErr) {
      console.error("❌ MySQL insert error:", dbErr);
      return res.status(500).json({
        message: "Database insert failed",
        sqlMessage: dbErr.sqlMessage,
        code: dbErr.code
      });
    }
  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ message: "Server error", details: err.message });
  }
});


// ✅ Default route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "frontpage.html"));
});

// ------------------ Start Server ------------------
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  const url = `http://localhost:${PORT}/`;
  switch (process.platform) {
    case "darwin": exec(`open ${url}`); break;
    case "win32": exec(`start ${url}`); break;
    case "linux": exec(`xdg-open ${url}`); break;
    default: console.log("⚠️ Open manually:", url);
  }
});
