//-----------------------------------------------------------------------------
// Name:       DreamHome.Notification Service                                   
//                                                                              
// Purpose:    Microservice                                                     
//                                                                              
// Interfaces: MongoDB database                                                 
//                                                                              
// Author:     Sal Carceller                                                    
//                                                                              
//-----------------------------------------------------------------------------
var http         = require('http');
var url          = require('url');
var express      = require('express');
var bodyParser   = require('body-parser');
var request      = require('request');
var mongoClient  = require('mongodb').MongoClient;
var helper       = require('./helpers'); // include helper functions from helpers.js

//-----------------------------------------------------------------------------
// Set up express                                    
var app = express();
var server = http.createServer(app);
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json()); // for parsing application/json
//-----------------------------------------------------------------------------

var _port = 8080;      // port that the node.js server will listen on

//-----------------------------------------------------------------------------
// return code definitions, used in json responses {"RC": _rcOK}  
var _rcOK      = 0;
var _rcWarning = 1;
var _rcError   = 2;
var _rcUnknown = 99;
//-----------------------------------------------------------------------------

// global refs to the db and the Notification collection
var _dbConnected      = false;
var _dbref            = null;
var _crefNotification = null; 

//-----------------------------------------------------------------------------
// Main code body
//-----------------------------------------------------------------------------
console.log("DreamHome.Notification ==> Begin Execution");

// wait for DB module to fully initialize and connect to the backend DB
// we don't want to start the node.js server listening till we know we are fully connected to the DB
helper.dbInit( function(err)
{
  if(!err)
  { // DB connections have been established. 
    _dbref            = helper.dbref();            // save the refrence handle to the db
    _crefNotification = helper.crefNotification(); // save the refrence handle to the Notification collection

    console.log('  ... application has successfully connected to the DB');
  }
  else
  { // OH no! something has gone wrong building DB connections!
    // we still proceed and start the server listening
    // but we mark the server as having a severe DB connection error!
    console.log('  ... WARNING: application failed to connect with the backend DB!');
  }

  // get the db connected indicator and save a refrence
  _dbConnected = helper.dbConnected();

  // Start the node.js server listening
  // even if the backend DB connection fails we still want to service requests
  app.listen(_port);

  console.log('  ... application now listening on port ' + _port);
});


//-----------------------------------------------------------------------------
// resets the notification collection
// deletes all records from the collection
//-----------------------------------------------------------------------------
app.get('/reset', function (req, res) 
{
  var retjson = {"RC":_rcOK};       // assume a good json response
  var statusCode = 200;            // assume valid http response code=200 (OK, good response)

  // test if connected to the DB
  if(_dbConnected==true)
  { // connected to the DB
    // delete all records in the collection
    _crefNotification.deleteMany( {}, {w:1, j:true} );

    retjson.success  = "Notification collection is now empty!";
  }
  else
  { // not connected to the DB
    retjson = {};
    retjson.RC = _rcError;
    retjson.error = "ERROR: we are not connected to the DB!";
    statusCode = 500;  // internal error while connecting to the DB
  }

  // send the http response message
  helper.httpJsonResponse(res,statusCode,retjson);

  return;
});

//-----------------------------------------------------------------------------
// Sends a notification to an agent and writes it to the mongoDB           
// Notification JSON record format is:
// { "_id":"580e196acced882d43d4a286", "notificationId":"notification1001", "agentId":"agent1001", "clientId":"client1003" }
// 
// syntax examples:
//   /notify?agentId=1001,clientId=1001
//-----------------------------------------------------------------------------
app.get('/notify', function (req, res) 
{
   var retjson = {"RC":_rcOK};       // assume a good json response
   var statusCode = 200;            // assume valid http response code=200 (OK, good response)

   // test if connected to the DB
   if(_dbConnected==true)
   { // connected to the DB
     var jsonRecord;                  // the json record to be added to the collection

     // check if queryParm has been sent?
     var queryObject = url.parse(req.url,true).query;
     var agentId     = queryObject.agentId;
     var clientId    = queryObject.clientId;
     if(agentId && clientId)
     { // we have the required parms
       // create a unique pkId (primaryKeyId ) for the notification record
       helper.genNotificationId(
       function(err,pkId)
       { // we should now have the generated unique pkId for the Notification Record
         if(!err)
         { // notificationId generated successfully
           // add the record/row to the Notification collection
           jsonRecord = { _id:pkId, 'notificationId':pkId, 'agentId':agentId, 'clientId':clientId};
           _crefNotification.insertOne( jsonRecord, {w:1, j:true},
           function(err,result)
           { 
             if(!err)
             {
               retjson.success  = "Agent has been notified, client should get a response shortly.";
             }
             else
             {
               statusCode    = 500;
               retjson.RC    = _rcError;
               retjson.error = "ERROR: failed to add record to Notification collection! err: " + err;
             }

             // send the http response message
             res.status(statusCode).json(retjson);
             res.end;
           });
         }
         else
         { // error generating the unique pkID!
           statusCode    = 500;
           retjson.RC    = _rcError;
           retjson.error = "ERROR: failed to generate pkID! err: " + err;

           // send the http response message
           res.status(statusCode).json(retjson);
           res.end;
         }
       });
     }
     else
     { // required parms missing
       retjson = {};
       retjson.RC = _rcError;
       retjson.error = "Missing parms, valid syntax: .../notify?agentId=1001&clientId=1001";
    
       // set http status code
       statusCode = 400;

       // send the http response message
       helper.httpJsonResponse(res,statusCode,retjson);
     }
   }
   else
   { // not connected to the DB
     retjson = {};
     retjson.RC = _rcError;
     retjson.error = "ERROR: we are not connected to the DB!";
     statusCode = 500;  // internal error while connecting to the DB

     // send the http response message
     helper.httpJsonResponse(res,statusCode,retjson);
   }

   return;
});

//-----------------------------------------------------------------------------
// Search for notification records within the notification collection in MongoDB
// syntax examples:
//   /search                                        get all records 
//   /search?query={"clientId":"client1003"}        get records by clientID 
//   /search?query={"agentId":"agent1001"}          get records by agentID 
//   /search?query={"notificationId":"agent100"}    get records by notificationID 
//-----------------------------------------------------------------------------
app.get('/search', function (req, res)
{
   var retjson = {"RC":_rcOK};       // assume a good json response
   var statusCode = 200;            // assume valid http response code=200 (OK, good response)

   // test if connected to the DB
   if(_dbConnected==true)
   { // connected to the DB
     var dbQuery;                     // query used for looking up records in the collection

     // check if queryParm has been sent?
     var queryObject = url.parse(req.url,true).query;
     var queryParm   = queryObject.query;
     if(queryParm)
     { // we have a query parm
       console.log(" ..queryParm " + queryParm);
       dbQuery = JSON.parse(queryParm);
     }
     else
     { // no query parm, assume query all records
       dbQuery = {};
     }

     // fetch records from the notification collection based on the query desired.
     _crefNotification.find(dbQuery).toArray( function(err, items) 
     {
        retjson = items;
    
        // send the http response message
        helper.httpJsonResponse(res,statusCode,retjson);
     });
   }
   else
   { // not connected to the DB
     retjson.RC = _rcError;
     retjson.error = "ERROR: we are not connected to the DB!";
     statusCode = 500;  // internal error while connecting to the DB

     // send the http response message
     helper.httpJsonResponse(res,statusCode,retjson);
   }

   return;
});

//-----------------------------------------------------------------------------
// Checks if we are connected to the DB and reports list of all collections           
//-----------------------------------------------------------------------------
app.get('/dbConnected', function(req, res)
{
  var retjson = {"RC":_rcOK};       // assume a good json response
  var statusCode = 200;            // assume valid http response code=200 (OK, good response)

  // test if connected to the DB
  if(_dbConnected==true)
  { // connected to the DB
    retjson.success = "Succesfully connected to the DB.";
  
    // Let's fetch the list of collections currently stored in the DB
    _dbref.listCollections().toArray(function(err, items) 
    {
      // add the list of collections found to the return JSON
      retjson.collections = items;
  
      // send the http response message
      helper.httpJsonResponse(res,statusCode,retjson);
    });
  }
  else
  { // not connected to the DB
    retjson.RC = _rcError;
    retjson.error = "ERROR: we are not connected to the DB!";
    statusCode = 500;  // internal error while connecting to the DB
  
    // send the http response message
    helper.httpJsonResponse(res,statusCode,retjson);
  }

  return;
});

//-----------------------------------------------------------------------------
// Simple echo get method, used to sanity test service
//-----------------------------------------------------------------------------
app.get('/echo', function (req, res) 
{
  console.log("app.get(./echo function has been called.");

  var retjson = {"RC":_rcOK};      // assume a good json response
  var statusCode = 200;            // assume valid http response code=200 (OK, good response)

  // send the http response message
  retjson.success = "Echo from DreamHome.Notification service!";
  res.status(statusCode).json(retjson);
  res.end;

  return;
});

//-----------------------------------------------------------------------------
// some testing methods, used to sanity test service
//-----------------------------------------------------------------------------
app.get('/test', function (req, res) 
{
  console.log("app.get(./test function has been called.");

  // test code
  helper.genClientId( 
  function(err,pkId)
  {
      console.log("app.get(./test function pkId:" + pkId);

      var retjson = {"RC":_rcOK};      // assume a good json response
      var statusCode = 200;            // assume valid http response code=200 (OK, good response)

      if(!err)
      {
        retjson.success = "pkId is " + pkId;
      }
      else
      { // error!
        statusCode = 400;
        retjson.RC = _rcError;
        retjson.error = err;
      }

      // send the http response message
      res.status(statusCode).json(retjson);
      res.end;
  });

  return;
});

app.get('/test2', function (req, res) 
{
  console.log("app.get(./test2 function has been called.");

  // force the Counter collection to be dropped (deleted)
  helper.crefCounter().drop(
  function(err, reply) 
  {
     var retjson = {"RC":_rcOK};      // assume a good json response
     var statusCode = 200;            // assume valid http response code=200 (OK, good response)

     if(!err)
     {
       retjson.success = "Counter collection has been dropped.";
     }
     else
     { // error!
       statusCode = 400;
       retjson.RC = _rcError;
       retjson.error = "ERROR: Failed to drop Counter Collection! err:" + err;
     }

     // send the http response message
     res.status(statusCode).json(retjson);
     res.end;
  });

  return;
});

// test put function
app.post('/test3', function (req, res) 
{
  console.log("app.post(./test3 function has been called.");

  var retjson = {"RC":_rcOK};      // assume a good json response
  var statusCode = 200;            // assume valid http response code=200 (OK, good response)

  var postData = JSON.stringify(req.body);
  retjson.sucess = "Post Data ->" + postData;

  // send the http response message
  res.status(statusCode).json(retjson);
  res.end;

  return;
});
