import { MongoClient, ServerApiVersion } from 'mongodb';

// for serverless cluster
// const uri = "mongodb+srv://Admin:eXiT75ji60c2Ic0v@cluster0.y0s4hc4.mongodb.net/?retryWrites=true&w=majority";

// for shared cluster
const uri = "mongodb+srv://adityaanilsharma00:adityaanil@cluster0.s2zhj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: true,
  }
});


export async function ConnectDB1() {
  try {
    await client.connect();
    console.log("Connected to database");
    return client;
  }
  catch (error) {
    console.error("Error connecting to database:", error);
  }
};

// Example usage
ConnectDB1().then(() => {
  console.log("Database connection established");
}).catch((error) => {
  console.error("Failed to connect to database:", error);
});
