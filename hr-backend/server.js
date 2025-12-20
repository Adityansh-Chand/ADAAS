const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose'); // Import Mongoose
const dotenv = require('dotenv'); // Import dotenv
const LeaveBalance = require('./models/LeaveBalance'); // Import Model

dotenv.config();

const app = express();
const port = 3000;

const mongoURI = process.env.MONGODB_URI;

if (!mongoURI) {
    throw new Error("MONGODB_URI is not defined");
}

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