const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose'); // Import Mongoose
const LeaveBalance = require('./models/LeaveBalance'); // Import Model

const app = express();
const port = 3000;

// *** CONNECTION STRING ***
const mongoURI = "mongodb+srv://admin:mn1AC%402004@cluster1.b2m1phr.mongodb.net/?appName=Cluster1";

app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(mongoURI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log(err));

// --- ENDPOINT: Get Leave Balance ---
app.get('/leave-balance', async (req, res) => {
    const employeeId = req.query.employee_id;
    console.log(`Searching DB for employee: ${employeeId}`);

    try {
        // Find the document in the database using the Mongoose model
        const data = await LeaveBalance.findOne({ employeeId: employeeId });

        if (data) {
            // Send the data found in MongoDB back to the Flutter app
            res.json(data);
        } else {
            res.status(404).json({ error: "Employee not found in DB" });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server Error" });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`HR Backend API running at http://localhost:${port}`);
});