ADAAS: Artificially Driven Assistant for Automated Solutions

ADAAS is an intelligent, mobile-first HR RAG Chatbot built with Flutter. It serves as a unified "Level 1" support interface for employees, designed to automate repetitive HR queries. The system intelligently routes user questions to either a Generative AI (for policy questions) or a Real-Time Database (for personal leave data).

🚀 Key Features

1. Intelligent Policy Support (RAG System)

Retrieval-Augmented Generation (RAG): The bot answers questions based strictly on the company's official policy handbook (e.g., "What is the sick leave policy?").

Source of Truth: Utilizes a curated JSON knowledge base containing 16 detailed HR policies (Conduct, Leave, IT Security, etc.).

Zero Hallucinations: The AI is instructed via prompt engineering to answer only from the provided context, ensuring factual accuracy.

Citation Support: Answers include citations (e.g., "Source: Leave Policy Guidelines, Section 3.1") to build trust.

2. Real-Time Personal Data (REST API & Database)

Dynamic Data Fetching: Recognizes user intent (e.g., "Show my leave balance") and automatically switches from AI generation to API data retrieval.

Database Backed: Fetches persistent employee records from a MongoDB Atlas cloud database via a custom Node.js/Express backend.

Rich UI Rendering: Displays complex data in structured, custom-built Data Tables directly within the chat stream, rather than just plain text.

3. Advanced Architecture (Flutter BLoC)

Intent Router: The BLoC acts as a central nervous system, analyzing user input to decide whether to call the ChatRepo (RAG) or LeaveApiRepo (API).

Scalable State Management: Uses a clean separation of concerns with BlocConsumer, ensuring the UI is reactive and testable.

Platform-Aware Networking: The app automatically detects if it's running on Web (localhost) or Android Emulator (10.0.2.2) to route API calls correctly.

📱 Application Architecture

The project follows a Layered Clean Architecture:

Presentation Layer (UI):

create_prompt.dart: Handles user input and renders the chat interface. Uses conditional logic to display text bubbles or data tables based on the message type.

Business Logic Layer (BLoC):

chat_bloc.dart: Manages the application state. Implements the "Intent Router" logic to switch between repositories.

Repository Layer (Data):

chat_repo.dart: Handles the RAG pipeline (Loading JSON -> Retrieving Context -> Augmenting Prompt -> Calling Gemini API).

leave_api_repo.dart: Handles communication with the Node.js backend.

Backend Layer:

server.js: A Node.js/Express server that exposes REST endpoints.

MongoDB Atlas: A cloud database storing employee leave records.

🛠️ Tech Stack

Frontend (Mobile App)

Framework: Flutter (Dart)

State Management: flutter_bloc

HTTP Client: dio (with interceptors and error handling)

Animations: lottie (for loading states)

Testing: flutter_test, bloc_test

Backend & Data

Generative AI: Google Gemini API (gemini-1.5-flash)

API Server: Node.js + Express

Database: MongoDB Atlas (Cloud)

ODM: Mongoose (for strict schema validation)

Knowledge Base: Local JSON (hr_knowledge_base.json)

📂 Project Structure

lib/
├── bloc/
│   ├── chat_bloc.dart      # The "Brain": Routes intent to RAG or API Repo
│   ├── chat_event.dart     # User actions (Send Message)
│   └── chat_state.dart     # Holds list of AppMessageModels
├── Model/
│   ├── chat_message_model.dart  # AppMessageModel (Text/Table) & Gemini Request Models
│   └── leave_balance_model.dart # Model for parsing API JSON response
├── repo/
│   ├── chat_repo.dart      # RAG Logic: Load JSON -> Retrieve Context -> Call Gemini
│   └── leave_api_repo.dart # API Logic: Connects to Node.js backend
├── utils/
│   └── constants.dart      # API Keys and config
└── create_prompt.dart      # UI: BlocConsumer, Chat Bubbles, Table Widget

hr-backend/                 # Backend Server Code
    ├── models/             # Mongoose Schemas (LeaveBalance.js)
    └── server.js           # Express App & MongoDB Connection

assets/
    ├── hr_knowledge_base.json  # The "Source of Truth" for RAG
    ├── loader.json             # Lottie animation
    └── images/                 # App assets


🔧 Installation & Setup

Prerequisites

Flutter SDK installed

Node.js & npm installed

MongoDB Atlas Account

Google Gemini API Key

Step 1: Setup the Flutter App

Clone the repository:

git clone [https://github.com/Adityansh-Chand/ADAAS.git](https://github.com/Adityansh-Chand/ADAAS.git)
cd ADAAS


Install dependencies:

flutter pub get


Configure API Key:

Open lib/utils/constants.dart.

Add your key: const apiKey = 'YOUR_GEMINI_API_KEY';

Step 2: Setup the Backend

Navigate to the backend folder:

cd hr-backend


Install Node dependencies:

npm install


Configure Database:

Open server.js.

Replace the mongoURI string with your MongoDB Atlas connection string.

Start the Server:

node server.js


(Keep this terminal running. It will listen on port 3000).

Step 3: Run the App

Open a new terminal in the root project folder.

Run:

flutter run


🧪 Testing Strategy

The project includes a robust suite of unit tests covering the critical logic layers:

RAG Retrieval Logic: Verifies that the correct policy is found for a given user query.

Intent Router Logic: Tests that "leave balance" queries go to the API and others go to RAG.

Data Parsing: Ensures the app handles API responses (and null values) safely.

To run the tests:

flutter test


---

# License

MIT License
