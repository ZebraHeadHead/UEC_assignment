
# Step 1


## How you explored the data before deciding anything, and what you noticed.
  From reading the CSV file:
  1. One action by one user creates several time stamps => User -> series of time stamps -> Record ID(same) 

    "User C did update serveral fields on 02-27-2026 13:00:31 PM"

  2. Two user can interact with the system at the same time. 
    So it's better in group by USER -> Time -> Record IDs(unreadable), Record(Readable)
  
  

## How you defined a group, and the trade-offs: groups that are too large hide things, and groups that are too small make the review impossible.
  1. My fisrt approach is to divide groups in chronological orders.#DROPPED
    
    02/2026 User C activities(Y/N): 
      TIME 1 (Record Type) Record #Record ID  APPROVE (Y/N) [add note?]
        Created Name (check mark)
        Set xxxx (check mark)
        Field Name update: xxxx -> yyyy (check mark)
        Unset xxxx (check mark)
        [Summary]
      
      TIME 2 (Record Type) Record #Record ID  APPROVE (Y/N) [add note?]
        Field Name update: xxxx -> yyyy (check mark)
        [Summary]
    
    With this approach everytime the system shows a list of acitivities done by user in a month, and provide a summary of each event(see in next seciton). Which I believe is a decent amount numbers per group.

     

## What a reviewer needs in order to make a decision, and how your interface supports it.
    Within the summary, I decide to encoprate an LLM to conduct the preliminary review. At the end of each event, create a new summary. And If the acitivies is flagged as risky. Show a warning for the review to expand and see the events.
# Step 2


## Work Flow:

Import, review, update, export.

Functional Requirements:

  1. Import:
    1.1: User able to load CSV into the App.
    1.2: App creates an addtional column to for the case status(Pending, Approved, Denied). Default all empty status into Not Reviewed.

  2. Review and update:
    2.1: App auto categorize all events.
    2.2: User can flag events as Approved or Denied.
    2.4: User can comment on cases.
    2.5: User can search events based on 
      Date	Name	Role	Context	Record Type	Record ID	Record	Type	Field	Old Value	New Value	Line Id	Line Transaction Id
  3. Export:
    3.1: User can export updated CSV.
    3.2: User can export only part of the CSV based on Date and Names and case statuses.
  
Non-functional Requirements:

  1. App can load 100k+ rows without crashing.


SCOPE 1:

Html file that allows drag and drop CSV files. Expect the file to be formatted as system_notes_sample.xlsx in this repo. 

User can search, and see different logs. all the other functions' buttons will exist but not in use. When clicked show a msg clearly saying its in progress.

SCOPE 2:

Impletment the approve deny comment section. Separately it from the search and filter function, so later if group standard changes, ie changing it to time and risky level based. This function won't be affected.


SCOPE 3: 

Implement the risk based filtering, assume that things involves cash-flow would be the important ones. Followed by ones that invovle massive fields or quoted in later

SCOPE 4: 

Implement the AI recap feature,instead of hit generate summary, auto summary at the end of the group. Note: grouping filter can be changed, so only sum it after grouping is completed. 

SCOPE 5#:

Implement Export function. 
Should be able to choose based on Time period/User/ Item Status(approved pending or denied). the output doc will be a xslx document similar to input document. Add a column at the end to indicate cases status.