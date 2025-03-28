// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import serveStatic from "serve-static";

import shopify from "./shopify.js";
import productCreator from "./product-creator.js";
import PrivacyWebhookHandlers from "./privacy.js";
import { ConnectDB1 } from "./db.js";
let connectToMongoDB = await ConnectDB1();

const PORT = parseInt(
  process.env.BACKEND_PORT || process.env.PORT || "3000",
  10
);

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// Set up Shopify authentication and webhook handling
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  async (req, res, next) => {
    console.log("============================================================");
    console.log("AUTHENTICATION CALLBACK TRIGGERED", new Date().toISOString());
    console.log(`URL: ${req.url}`);
    console.log(`Query params: ${JSON.stringify(req.query)}`);
    console.log("============================================================");
    
    try {
      // Make sure we have an active session
      const session = res.locals.shopify.session;
      if (!session) {
        console.log("❌ No Shopify session available after auth");
        return next();
      }
  
      console.log(`✅ App successfully installed on ${session.shop}, initializing data...`);
      console.log("Session details:", {
        shop: session.shop,
        scopes: session.scope,
        isOnline: session.isOnline,
        hasAccessToken: !!session.accessToken,
        accessTokenLength: session.accessToken ? session.accessToken.length : 0
      });
      
      try {
        // 1. Register product webhooks for auto-syncing when products change
        console.log(`🔄 Starting webhook registration for ${session.shop}...`);
        const webhookResult = await registerProductWebhooks(session);
        console.log(`${webhookResult ? '✅' : '❌'} Webhook registration ${webhookResult ? 'successful' : 'failed'} for ${session.shop}`);
        
        // 2. Perform initial sync of all product images
        console.log(`🔄 Starting product sync for ${session.shop}...`);
        const shopName = session.shop;
        
        console.log("About to call syncAllProductImages with session:", {
          shop: session.shop,
          hasAccessToken: !!session.accessToken
        });
        
        const syncResult = await syncAllProductImages(shopName, session);
        
        console.log(`${syncResult.success ? '✅' : '❌'} Initial product sync for ${shopName}:`, 
          syncResult.success 
            ? `Processed ${syncResult.totalProcessed} products (${syncResult.inserted} inserted, ${syncResult.updated} updated)`
            : `Failed: ${syncResult.error}`
        );
      } catch (syncError) {
        // Log the error but don't block the auth flow
        console.error(`❌ Error during initial setup for ${session.shop}:`, syncError);
        console.error("Error stack:", syncError.stack);
      }
      
      // Continue with the redirect regardless of sync results
      console.log(`✅ Auth flow complete for ${session.shop}, redirecting to app...`);
      console.log("============================================================");
      next();
    } catch (error) {
      console.error("❌ Error in after-auth callback:", error);
      console.error("Error stack:", error.stack);
      console.log("============================================================");
      // Still redirect to app even if there was an error
      next();
    }
  },
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers })
);


// Register product webhooks to keep MongoDB in sync
async function registerProductWebhooks(session) {
  try {
    const webhooks = [
      {
        path: "/webhooks/products/create",
        topic: "PRODUCTS_CREATE",
        accessLevel: "READ_PRODUCTS"
      },
      {
        path: "/webhooks/products/update",
        topic: "PRODUCTS_UPDATE",
        accessLevel: "READ_PRODUCTS"
      },
      {
        path: "/webhooks/products/delete",
        topic: "PRODUCTS_DELETE",
        accessLevel: "READ_PRODUCTS"
      }
    ];

    for (const webhook of webhooks) {
      // @ts-ignore - TypeScript doesn't correctly recognize the webhooks API
      await shopify.api.webhooks.addHandlers({
        [webhook.topic]: [
          {
            // Use string value directly instead of DeliveryMethod enum
            deliveryMethod: "http",
            callbackUrl: webhook.path,
            callback: async (topic, shop, body) => {
              console.log(`Received ${topic} webhook from ${shop}`);
              
              // Get shop session
              let DatabaseSession = connectToMongoDB?.db("Sessions");
              let collectionSession = DatabaseSession?.collection('shopify_sessions');
              const sessionObject = await collectionSession?.findOne({ shop });
              
              if (sessionObject) {
                // Sync product images when a product is created or updated
                await syncAllProductImages(shop, sessionObject);
              }
            },
          },
        ],
      });
    }
    console.log('Product webhooks registered successfully');
    return true;
  } catch (error) {
    console.error('Error registering product webhooks:', error);
    return false;
  }
}



// If you are adding routes outside of the /api path, remember to
// also add a proxy rule for them in web/frontend/vite.config.js

app.use("/api/*", shopify.validateAuthenticatedSession());

app.use(express.json());

app.get("/api/products/count", async (_req, res) => {
  const client = new shopify.api.clients.Graphql({
    session: res.locals.shopify.session,
  });

  const countData = await client.request(`
    query shopifyProductCount {
      productsCount {
        count
      }
    }
  `);

  res.status(200).send({ count: countData.data.productsCount.count });
});

app.post("/api/products", async (_req, res) => {
  let status = 200;
  let error = null;

  try {
    await productCreator(res.locals.shopify.session);
  } catch (e) {
    console.log(`Failed to process products/create: ${e.message}`);
    status = 500;
    error = e.message;
  }
  res.status(status).send({ success: status === 200, error });
});

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  res
    .status(200)
    .set("Content-Type", "text/html")
    .send(
      readFileSync(join(STATIC_PATH, "index.html"))
        .toString()
        .replace("%VITE_SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY || "")
    );
});

/**
 * Fetches product images using Shopify GraphQL API
 * @param {Object} session - The Shopify session object
 * @param {number} limit - Maximum number of products to fetch (default: 10)
 * @param {string|undefined} cursor - Pagination cursor for fetching next set of products
 * @returns {Promise<Object>} - Product images data
 */
async function fetchProductImages(session, limit = 10, cursor = undefined) {
  console.log(`⚡ fetchProductImages called with limit: ${limit}, cursor: ${cursor ? 'exists' : 'none'}`);
  console.log("Session info:", {
    shop: session?.shop,
    hasAccessToken: !!session?.accessToken,
    accessTokenLength: session?.accessToken ? session.accessToken.length : 0
  });
  
  try {
    if (!session || !session.accessToken) {
      console.error("❌ Invalid session in fetchProductImages:", { 
        hasSession: !!session, 
        hasAccessToken: session ? !!session.accessToken : false,
        sessionKeys: session ? Object.keys(session) : []
      });
      throw new Error("Invalid session or missing access token");
    }
    
    console.log("🔄 Creating GraphQL client with session for shop:", session.shop);
    const client = new shopify.api.clients.Graphql({
      session: session,
    });
    
    console.log("✅ GraphQL client created, executing query with variables:", {
      limit: limit,
      cursor: cursor
    });
    
    // Log the exact query for debugging
    const queryString = `
      query GetProductImages($limit: Int!, $cursor: String) {
        products(first: $limit, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              handle
              images(first: 10) {
                edges {
                  node {
                    id
                    url
                    altText
                    width
                    height
                  }
                }
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    price
                    sku
                    image {
                      id
                      url
                      altText
                      width
                      height
                    }
                  }
                }
              }
              featuredImage {
                id
                url
                altText
                width
                height
              }
            }
          }
        }
      }
    `;

    console.log("🔍 About to execute GraphQL request with:", {
      clientExists: !!client,
      clientRequestMethod: typeof client.request,
      sessionShop: session.shop,
      accessTokenExists: !!session.accessToken
    });

    // Make the actual request with error handling
    try {
      const response = await client.request(queryString, {
        variables: {
          limit: limit,
          cursor: cursor,
        },
      });
      
      console.log("✅ GraphQL request completed successfully");
      
      if (!response || !response.data || !response.data.products) {
        console.error("❌ Invalid GraphQL response:", response);
        throw new Error("Invalid GraphQL response");
      }
      
      console.log(`✅ Query successful, received ${response.data.products.edges?.length || 0} products`);
      
      return response.data.products;
    } catch (graphqlError) {
      console.error("❌ GraphQL request failed:", graphqlError.message);
      console.error("Original error:", graphqlError);
      if (graphqlError.response) {
        console.error("GraphQL error response:", graphqlError.response);
      }
      throw graphqlError;
    }
  } catch (error) {
    console.error("❌ Error in fetchProductImages:", error.message);
    console.error("Error stack:", error.stack);
    throw error;
  }
}

/**
 * Stores product images in MongoDB by variant
 * @param {Object} shopName - The shop identifier
 * @param {Object} productsData - The product data including images and variants
 * @returns {Promise<Object>} - Result of the storage operation
 */
async function storeProductImagesInMongoDB(shopName, productsData) {
  try {
    if (!connectToMongoDB) {
      console.error("MongoDB connection not available");
      return { success: false, error: "Database connection not available" };
    }

    const db = connectToMongoDB.db("ProductData");
    const productImagesCollection = db.collection('product_images');

    // Track products that are processed to detect deletions later
    const processedProductIds = [];
    let insertedCount = 0;
    let updatedCount = 0;

    // Process each product and its variants
    for (const edge of productsData.edges) {
      const product = edge.node;
      const productId = product.id;
      processedProductIds.push(productId);

      // Prepare master product document with general images
      const productDoc = {
        shopName,
        productId,
        title: product.title,
        handle: product.handle,
        updatedAt: new Date(),
        featuredImage: product.featuredImage,
        images: product.images?.edges.map(imgEdge => imgEdge.node) || []
      };

      // Process variants
      if (product.variants && product.variants.edges) {
        productDoc.variants = product.variants.edges.map(variantEdge => {
          const variant = variantEdge.node;
          return {
            variantId: variant.id,
            title: variant.title,
            price: variant.price,
            sku: variant.sku,
            image: variant.image
          };
        });
      }

      // Upsert the product document - insert if doesn't exist, update if it does
      const result = await productImagesCollection.updateOne(
        { shopName, productId },
        { $set: productDoc },
        { upsert: true }
      );

      if (result.upsertedCount) {
        insertedCount++;
      } else if (result.modifiedCount) {
        updatedCount++;
      }
    }

    // Optional: Remove products that no longer exist in the store
    // This is useful when a product is deleted in Shopify
    if (processedProductIds.length > 0) {
      const deleteResult = await productImagesCollection.deleteMany({
        shopName,
        productId: { $nin: processedProductIds }
      });

      return {
        success: true,
        inserted: insertedCount,
        updated: updatedCount,
        deleted: deleteResult.deletedCount
      };
    }

    return {
      success: true,
      inserted: insertedCount,
      updated: updatedCount
    };
  } catch (error) {
    console.error("Error storing product images:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Fetches and stores all product images from a shop
 * @param {string} shopName - The shop name
 * @param {Object} session - The Shopify session
 * @returns {Promise<Object>} - Operation results
 */
async function syncAllProductImages(shopName, session) {
  console.log(`Starting syncAllProductImages for ${shopName}`);
  console.log(`Session object available: ${!!session}`);
  
  try {
    // Verify session has required properties
    if (!session || !session.accessToken) {
      console.error(`Invalid session for ${shopName}:`, { 
        hasSession: !!session, 
        hasAccessToken: session ? !!session.accessToken : false
      });
      return { success: false, error: "Invalid session or missing access token" };
    }
    
    console.log(`Session looks valid for ${shopName}, proceeding with sync...`);
    
    let hasNextPage = true;
    let cursor = undefined;
    let totalProcessed = 0;
    let syncResults = { inserted: 0, updated: 0, deleted: 0 };
    let startTime = new Date();
    
    // Create a sync status record in MongoDB
    const ProductDataDB = connectToMongoDB?.db("ProductData");
    const syncStatusCollection = ProductDataDB?.collection('sync_status');
    
    // Create initial status
    const syncId = new Date().getTime().toString();
    await syncStatusCollection?.insertOne({
      syncId,
      shopName,
      status: "started",
      startedAt: startTime,
      updatedAt: startTime,
      progress: 0,
      message: "Sync process started"
    });
    
    // Update status periodically
    const updateStatus = async (status, progress, message) => {
      await syncStatusCollection?.updateOne(
        { syncId },
        { 
          $set: { 
            status, 
            progress, 
            message, 
            updatedAt: new Date()
          } 
        }
      );
    };

    try {
      // Paginate through all products
      while (hasNextPage) {
        // Update status
        await updateStatus(
          "in_progress", 
          totalProcessed > 0 ? (totalProcessed / (totalProcessed + 50)) * 100 : 10,
          `Processing products - ${totalProcessed} completed so far`
        );
        
        const productsData = await fetchProductImages(session, 50, cursor);
        
        if (!productsData || !productsData.edges || productsData.edges.length === 0) {
          break;
        }

        const storageResult = await storeProductImagesInMongoDB(shopName, productsData);
        
        if (!storageResult.success) {
          await updateStatus("failed", 0, `Storage error: ${storageResult.error}`);
          return { success: false, error: storageResult.error };
        }

        // Update tracking counters
        syncResults.inserted += storageResult.inserted || 0;
        syncResults.updated += storageResult.updated || 0;
        syncResults.deleted += storageResult.deleted || 0;
        
        totalProcessed += productsData.edges.length;
        
        // Check if we need to fetch more products
        hasNextPage = productsData.pageInfo?.hasNextPage;
        cursor = productsData.pageInfo?.endCursor;
      }
      
      // Final update
      const endTime = new Date();
      const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;
      
      await updateStatus(
        "completed", 
        100, 
        `Sync completed: ${totalProcessed} products processed in ${durationSeconds} seconds`
      );
      
      return {
        success: true,
        totalProcessed,
        duration: durationSeconds,
        ...syncResults
      };
    } catch (error) {
      await updateStatus("error", 0, `Error during sync: ${error.message}`);
      throw error;
    }
  } catch (error) {
    console.error("Error syncing product images:", error);
    return { success: false, error: error.message };
  }
}

app.listen(PORT);
